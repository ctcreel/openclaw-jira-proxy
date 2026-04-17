#!/usr/bin/env bash
#
# Refresh the Claude OAuth credentials file using the stored refresh_token.
#
# Background: `claude -p` non-interactive invocations don't refresh the
# access token even though the refresh_token is right there in the
# credentials file. The Mac worked around this by re-reading from
# Keychain (which Claude Desktop kept fresh). On Linux there is no such
# helper — this script does the refresh directly against the OAuth
# endpoint and rewrites the credentials file in place.
#
# Run periodically via systemd timer (clawndom-claude-refresh.timer).
# Skips the network call when the token still has plenty of life.
#
# Idempotent. Logs to /var/log/clawndom/claude-refresh.log.

set -euo pipefail

CREDS="${CLAUDE_CREDENTIALS_PATH:-/home/clawndom/.claude/.credentials.json}"
TOKEN_URL="https://platform.claude.com/v1/oauth/token"
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
SKIP_THRESHOLD_SECONDS=7200

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1"; }

if [[ ! -f "$CREDS" ]]; then
  log "ERROR: $CREDS missing — run 'claude login' first"
  exit 1
fi

SECONDS_LEFT=$(python3 - <<PY
import json, time
data = json.load(open("$CREDS"))
expires_at = data["claudeAiOauth"]["expiresAt"]
now_ms = int(time.time() * 1000)
print(max((expires_at - now_ms) // 1000, -1))
PY
)

if (( SECONDS_LEFT > SKIP_THRESHOLD_SECONDS )); then
  log "Token has ${SECONDS_LEFT}s left (>${SKIP_THRESHOLD_SECONDS}) — skip"
  exit 0
fi

REFRESH_TOKEN=$(python3 -c "import json; print(json.load(open('$CREDS'))['claudeAiOauth']['refreshToken'])")

RESPONSE_FILE=$(mktemp)
HTTP_CODE=$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -X POST "$TOKEN_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "refresh_token=$REFRESH_TOKEN" \
  --data-urlencode "client_id=$CLIENT_ID")

if [[ "$HTTP_CODE" != "200" ]]; then
  log "ERROR: refresh HTTP $HTTP_CODE — body: $(cat "$RESPONSE_FILE")"
  rm -f "$RESPONSE_FILE"
  exit 1
fi

python3 - "$CREDS" "$RESPONSE_FILE" <<'PY'
import json, os, sys, tempfile, time

creds_path, response_path = sys.argv[1], sys.argv[2]
existing = json.load(open(creds_path))
response = json.load(open(response_path))

oauth = existing["claudeAiOauth"]
oauth["accessToken"] = response["access_token"]
if "refresh_token" in response:
    oauth["refreshToken"] = response["refresh_token"]
expires_in = int(response.get("expires_in", 28800))
oauth["expiresAt"] = int((time.time() + expires_in) * 1000)
if "scope" in response and isinstance(response["scope"], str):
    oauth["scopes"] = response["scope"].split()

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(creds_path))
try:
    with os.fdopen(fd, "w") as f:
        json.dump(existing, f)
    os.chmod(tmp, 0o600)
    os.rename(tmp, creds_path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)

print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} OK: refreshed; expires in {expires_in}s")
PY

rm -f "$RESPONSE_FILE"
