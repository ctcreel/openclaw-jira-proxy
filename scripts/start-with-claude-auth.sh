#!/usr/bin/env bash
# Startup wrapper for clawndom.
# CLAUDE_CODE_OAUTH_TOKEN must be set in the launchd plist EnvironmentVariables.
# Use scripts/refresh-claude-token.sh to update it when the token expires.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "ERROR: CLAUDE_CODE_OAUTH_TOKEN not set." >&2
  echo "Run: scripts/refresh-claude-token.sh" >&2
  exit 1
fi

exec node "$PROJECT_DIR/dist/server.js"
