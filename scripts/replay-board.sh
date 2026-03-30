#!/usr/bin/env bash
#
# replay-board.sh — Query Jira for Patches' actionable tickets
# and fire simulated webhooks through Clawndom.
#
# Usage: ./scripts/replay-board.sh [--dry-run]
#
set -euo pipefail

DRY_RUN="${1:-}"
CLAWNDOM_URL="http://127.0.0.1:8793/hooks/jira"
HMAC_SECRET="35a5e5f81c763cfce937f1b76c0f6cbf774e67f0537b1b75b70ef0775b8d34a4"
PATCHES_ACCOUNT_ID="712020:2fbdb38e-012b-43a6-b286-4339c24baabc"
JIRA_CLOUD_ID="10449a34-7d09-4681-85d9-038414693fbd"
JIRA_API="https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3"

# --- 1Password: pull Jira OAuth credentials ---
OP_TOKEN=$(security find-generic-password -s "openclaw.op_token_patch" -a "openclaw" -w 2>/dev/null)
CLIENT_ID=$(OP_SERVICE_ACCOUNT_TOKEN="$OP_TOKEN" op item get z74ovcwsybnehh72eorriuj2fy --vault Patch --fields "Client ID" --reveal 2>/dev/null)
CLIENT_SECRET=$(OP_SERVICE_ACCOUNT_TOKEN="$OP_TOKEN" op item get z74ovcwsybnehh72eorriuj2fy --vault Patch --fields "Client secret" --reveal 2>/dev/null)

# --- Get Jira bearer token ---
JIRA_TOKEN=$(curl -s -X POST "https://auth.atlassian.com/oauth/token" \
  -H "Content-Type: application/json" \
  -d "{\"grant_type\":\"client_credentials\",\"client_id\":\"$CLIENT_ID\",\"client_secret\":\"$CLIENT_SECRET\"}" \
  | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['access_token'])")

echo "✅ Jira OAuth token acquired"

# --- Query board ---
JQL="project = SPE AND assignee = \"${PATCHES_ACCOUNT_ID}\" AND status IN (\"Plan\", \"Ready for Development\", \"In Development\") ORDER BY status ASC, priority ASC"

ISSUES_JSON=$(curl -s -X POST "${JIRA_API}/search/jql" \
  -H "Authorization: Bearer $JIRA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"jql\":$(python3 -c "import json; print(json.dumps('''$JQL'''))"),\"fields\":[\"summary\",\"status\",\"assignee\",\"priority\",\"issuetype\",\"reporter\"]}")

ISSUE_COUNT=$(echo "$ISSUES_JSON" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(len(d.get('issues',[])))")
echo "📋 Found $ISSUE_COUNT actionable tickets"

if [ "$ISSUE_COUNT" -eq 0 ]; then
  echo "Nothing to replay."
  exit 0
fi

# --- Print what we found ---
echo "$ISSUES_JSON" | python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
for i in data['issues']:
    f = i['fields']
    status = f['status']['name']
    print(f'  {i[\"key\"]:12} [{status:25}] {f[\"summary\"]}')
"

echo ""

# --- Build and fire webhooks ---
echo "$ISSUES_JSON" | python3 -c "
import sys, json, subprocess, hmac, hashlib

data = json.loads(sys.stdin.read())
dry_run = '$DRY_RUN' == '--dry-run'
clawndom_url = '$CLAWNDOM_URL'
hmac_secret = '$HMAC_SECRET'

# Map status to a plausible webhook event
STATUS_TO_EVENT = {
    'Plan': 'jira:issue_updated',
    'Ready for Development': 'jira:issue_updated',
    'In Development': 'jira:issue_updated',
}

STATUS_TO_TRANSITION = {
    'Plan': {'fromString': 'Backlog', 'toString': 'Plan'},
    'Ready for Development': {'fromString': 'Plan Review', 'toString': 'Ready for Development'},
    'In Development': {'fromString': 'Ready for Development', 'toString': 'In Development'},
}

for issue in data['issues']:
    f = issue['fields']
    status_name = f['status']['name']

    # Build a Jira webhook payload
    payload = json.dumps({
        'webhookEvent': STATUS_TO_EVENT.get(status_name, 'jira:issue_updated'),
        'issue': {
            'key': issue['key'],
            'fields': {
                'summary': f['summary'],
                'status': f['status'],
                'assignee': f.get('assignee'),
                'priority': f.get('priority'),
                'issuetype': f.get('issuetype'),
                'reporter': f.get('reporter'),
            },
        },
        'changelog': {
            'items': [{
                'field': 'status',
                **STATUS_TO_TRANSITION.get(status_name, {'fromString': 'Unknown', 'toString': status_name}),
            }],
        },
        'user': {
            'displayName': 'replay-board.sh',
        },
    }, separators=(',', ':'))

    # HMAC-SHA256 sign
    sig = 'sha256=' + hmac.new(hmac_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

    if dry_run:
        print(f'🔍 [DRY RUN] {issue[\"key\"]} — would POST {len(payload)} bytes')
        continue

    # Fire it
    result = subprocess.run(
        ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
         '-X', 'POST', clawndom_url,
         '-H', 'Content-Type: application/json',
         '-H', f'X-Hub-Signature: {sig}',
         '-d', payload],
        capture_output=True, text=True
    )
    status_code = result.stdout.strip()
    icon = '✅' if status_code == '202' else '❌'
    print(f'{icon} {issue[\"key\"]} — HTTP {status_code}')
"

echo ""
echo "🎯 All webhooks fired. Check: tail -f /usr/local/var/log/clawndom.log"
