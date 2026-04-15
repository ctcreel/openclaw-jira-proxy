#!/usr/bin/env bash
# Extracts the Claude Code OAuth token from the macOS Keychain and updates
# the clawndom launchd plist with it, then reloads the service.
#
# MUST be run from an interactive session (not launchd) — the Keychain
# is only accessible from the user's login session.
#
# Usage: ./scripts/refresh-claude-token.sh

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.openclaw.clawndom.plist"

if [ ! -f "$PLIST" ]; then
  echo "Error: Plist not found at $PLIST" >&2
  echo "Run install.sh first." >&2
  exit 1
fi

# Extract token from Keychain
TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "Error: Could not extract Claude OAuth token from Keychain." >&2
  echo "Make sure you are logged in: claude /status" >&2
  exit 1
fi

echo "Token extracted (${#TOKEN} chars)"

# Update the plist
if grep -q "CLAUDE_CODE_OAUTH_TOKEN" "$PLIST"; then
  # Replace existing token value
  python3 -c "
import plistlib, sys

with open('$PLIST', 'rb') as f:
    plist = plistlib.load(f)

plist['EnvironmentVariables']['CLAUDE_CODE_OAUTH_TOKEN'] = '$TOKEN'

with open('$PLIST', 'wb') as f:
    plistlib.dump(plist, f)
"
  echo "Updated existing CLAUDE_CODE_OAUTH_TOKEN in plist"
else
  echo "Error: CLAUDE_CODE_OAUTH_TOKEN not found in plist." >&2
  echo "Re-run install.sh to set up the Claude CLI runner." >&2
  exit 1
fi

# Reload service
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Service reloaded."
echo ""
echo "Verify: curl -s http://localhost:8793/api/health | python3 -m json.tool"
