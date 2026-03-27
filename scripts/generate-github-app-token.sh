#!/bin/bash
# Generate a GitHub App installation token for the SignalField Claude bot.
#
# Prerequisites:
#   - 1Password CLI (`op`) installed and authenticated
#   - PyJWT installed (`pip install pyjwt[crypto]` or available via `uv run`)
#   - Access to the Engineering vault in 1Password
#
# Usage:
#   ./scripts/generate-github-app-token.sh
#
# Outputs:
#   Writes the token to /tmp/gh_app_token
#   Prints the token to stdout for capture in scripts
#
# The token expires after 1 hour. Re-run this script to generate a new one.

set -euo pipefail

BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# 1Password item details
OP_ITEM="GITHUB_APP_SIGNALFIELD_CLAUDE"
OP_VAULT="Engineering"

echo -e "${BLUE}Fetching GitHub App credentials from 1Password...${NC}" >&2

# Read credentials from 1Password
APP_ID=$(op read "op://${OP_VAULT}/${OP_ITEM}/app_id" 2>/dev/null) || {
    echo -e "${RED}Error: Could not read app_id from 1Password${NC}" >&2
    echo -e "${RED}Make sure you're signed in: eval \$(op signin)${NC}" >&2
    exit 1
}

INSTALLATION_ID=$(op read "op://${OP_VAULT}/${OP_ITEM}/installation_id" 2>/dev/null) || {
    echo -e "${RED}Error: Could not read installation_id from 1Password${NC}" >&2
    exit 1
}

PRIVATE_KEY=$(op read "op://${OP_VAULT}/${OP_ITEM}/private_key" 2>/dev/null) || {
    echo -e "${RED}Error: Could not read private_key from 1Password${NC}" >&2
    exit 1
}

echo -e "${BLUE}Generating installation token (App ID: ${APP_ID})...${NC}" >&2

# Generate JWT and exchange for installation token
TOKEN=$(python3 -c "
import jwt
import time
import json
import urllib.request
import sys

private_key = '''${PRIVATE_KEY}'''
app_id = '${APP_ID}'
installation_id = '${INSTALLATION_ID}'

now = int(time.time())
payload = {
    'iat': now - 60,
    'exp': now + (10 * 60),
    'iss': app_id,
}

try:
    encoded_jwt = jwt.encode(payload, private_key, algorithm='RS256')
except Exception as e:
    print(f'JWT generation failed: {e}', file=sys.stderr)
    sys.exit(1)

req = urllib.request.Request(
    f'https://api.github.com/app/installations/{installation_id}/access_tokens',
    method='POST',
    headers={
        'Authorization': f'Bearer {encoded_jwt}',
        'Accept': 'application/vnd.github+json',
    },
)

try:
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
        print(data['token'])
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f'GitHub API error ({e.code}): {body}', file=sys.stderr)
    sys.exit(1)
") || {
    echo -e "${RED}Error: Token generation failed${NC}" >&2
    exit 1
}

# Save token to temp file
echo -n "$TOKEN" > /tmp/gh_app_token

echo -e "${GREEN}Token generated and saved to /tmp/gh_app_token${NC}" >&2
echo -e "${GREEN}Expires in ~1 hour. Bot identity: signalfield-claude[bot]${NC}" >&2

# Output token to stdout for capture
echo "$TOKEN"
