#!/usr/bin/env bash
set -euo pipefail

echo "=== openclaw-jira-proxy installer ==="
echo ""

# Check Node.js >= 22
if ! command -v node &> /dev/null; then
  echo "Error: Node.js is not installed." >&2
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "Error: Node.js >= 22 required (found $(node -v))" >&2
  exit 1
fi

# Check pnpm
if ! command -v pnpm &> /dev/null; then
  echo "Error: pnpm is not installed." >&2
  exit 1
fi

echo "Node.js $(node -v) and pnpm $(pnpm -v) detected."
echo ""

# Prompt for configuration
read -rp "JIRA_HMAC_SECRET: " JIRA_HMAC_SECRET
if [ -z "$JIRA_HMAC_SECRET" ]; then
  echo "Error: JIRA_HMAC_SECRET is required." >&2
  exit 1
fi

read -rp "OPENCLAW_TOKEN: " OPENCLAW_TOKEN
if [ -z "$OPENCLAW_TOKEN" ]; then
  echo "Error: OPENCLAW_TOKEN is required." >&2
  exit 1
fi

read -rp "OPENCLAW_HOOK_URL [http://127.0.0.1:18789/hooks/jira]: " OPENCLAW_HOOK_URL
OPENCLAW_HOOK_URL="${OPENCLAW_HOOK_URL:-http://127.0.0.1:18789/hooks/jira}"

read -rp "REDIS_URL [redis://127.0.0.1:6379]: " REDIS_URL
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

read -rp "PORT [8792]: " PORT
PORT="${PORT:-8792}"

echo ""
echo "Building..."
pnpm install
pnpm build

INSTALL_PATH="$(pwd)"
PLIST_SRC="infra/launchd/com.openclaw.jira-proxy.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.openclaw.jira-proxy.plist"

# Generate plist with substituted values
sed \
  -e "s|INSTALL_PATH|${INSTALL_PATH}|g" \
  -e "s|>JIRA_HMAC_SECRET<|>${JIRA_HMAC_SECRET}<|g" \
  -e "s|>OPENCLAW_TOKEN<|>${OPENCLAW_TOKEN}<|g" \
  -e "s|>OPENCLAW_HOOK_URL<|>${OPENCLAW_HOOK_URL}<|g" \
  -e "s|>REDIS_URL<|>${REDIS_URL}<|g" \
  -e "s|>PORT<|>${PORT}<|g" \
  "$PLIST_SRC" > "$PLIST_DST"

echo "Plist written to $PLIST_DST"

# Load the service
launchctl load "$PLIST_DST"

echo ""
echo "Proxy installed. Test: curl -s http://127.0.0.1:${PORT}/api/health"
