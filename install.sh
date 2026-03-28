#!/usr/bin/env bash
set -euo pipefail

echo "=== clawndom installer ==="
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
read -rp "OPENCLAW_TOKEN: " OPENCLAW_TOKEN
if [ -z "$OPENCLAW_TOKEN" ]; then
  echo "Error: OPENCLAW_TOKEN is required." >&2
  exit 1
fi

read -rp "JIRA_HMAC_SECRET (leave blank to skip): " JIRA_HMAC_SECRET

read -rp "GITHUB_HMAC_SECRET (leave blank to skip): " GITHUB_HMAC_SECRET

if [ -z "$JIRA_HMAC_SECRET" ] && [ -z "$GITHUB_HMAC_SECRET" ]; then
  echo "Error: At least one provider HMAC secret is required." >&2
  exit 1
fi

read -rp "REDIS_URL [redis://127.0.0.1:6379]: " REDIS_URL
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

read -rp "PORT [8792]: " PORT
PORT="${PORT:-8792}"

echo ""
echo "Building..."

# Install dependencies and build
pnpm install --frozen-lockfile
pnpm build

INSTALL_PATH="$(pwd)"
PLIST_SRC="infra/launchd/com.openclaw.clawndom.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.openclaw.clawndom.plist"

# Unload existing service if present
if launchctl list | grep -q com.openclaw.clawndom 2>/dev/null; then
  echo "Unloading existing service..."
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

# Also unload old jira-proxy service if present
if launchctl list | grep -q com.openclaw.jira-proxy 2>/dev/null; then
  echo "Unloading old jira-proxy service..."
  launchctl unload "$HOME/Library/LaunchAgents/com.openclaw.jira-proxy.plist" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.openclaw.jira-proxy.plist"
fi

# Configure plist
cp "$PLIST_SRC" "$PLIST_DST"
sed -i '' "s|INSTALL_PATH|$INSTALL_PATH|g" "$PLIST_DST"
sed -i '' "s|OPENCLAW_TOKEN|$OPENCLAW_TOKEN|g" "$PLIST_DST"
sed -i '' "s|REDIS_URL|$REDIS_URL|g" "$PLIST_DST"
sed -i '' "s|>PORT<|>$PORT<|g" "$PLIST_DST"

if [ -n "$JIRA_HMAC_SECRET" ]; then
  sed -i '' "s|JIRA_HMAC_SECRET|$JIRA_HMAC_SECRET|g" "$PLIST_DST"
else
  # Remove Jira secret entry if not provided
  sed -i '' '/<key>JIRA_HMAC_SECRET<\/key>/,/<string>.*<\/string>/d' "$PLIST_DST"
fi

# Load service
launchctl load "$PLIST_DST"

echo ""
echo "✅ clawndom installed and running on port $PORT"
echo ""
echo "Next steps:"
echo "  1. Set up Tailscale Funnel: tailscale funnel --bg --set-path /hooks/jira $PORT"
echo "  2. Configure your webhook provider to point to https://<machine>.ts.net/hooks/<provider>"
echo "  3. Check health: curl http://localhost:$PORT/api/health"
