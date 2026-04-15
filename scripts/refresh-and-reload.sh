#!/usr/bin/env bash
# Extracts a fresh Claude OAuth token from the macOS Keychain and
# updates the clawndom plist, then reloads the service.
#
# Runs as a separate launchd agent on a schedule (every 6 hours).
# Must run in the user's GUI session (Aqua) to access the Keychain.

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.openclaw.clawndom.plist"
LOG="/usr/local/var/log/clawndom-refresh.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

if [ ! -f "$PLIST" ]; then
  log "ERROR: Plist not found at $PLIST"
  exit 1
fi

# Extract token from Keychain
TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" 2>/dev/null || true)

if [ -z "$TOKEN" ]; then
  log "ERROR: Could not extract Claude OAuth token from Keychain"
  exit 1
fi

# Update plist via plutil (preserves XML format)
python3 -c "
import plistlib, sys
with open('$PLIST', 'rb') as f:
    plist = plistlib.load(f)
plist['EnvironmentVariables']['CLAUDE_CODE_OAUTH_TOKEN'] = '$TOKEN'
with open('$PLIST', 'wb') as f:
    plistlib.dump(plist, f)
" && plutil -convert xml1 "$PLIST"

# Reload clawndom
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

log "OK: Token refreshed and service reloaded"
