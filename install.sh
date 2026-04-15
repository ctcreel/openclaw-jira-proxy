#!/usr/bin/env bash
set -euo pipefail

echo "=== clawndom installer ==="
echo ""

# ============================================================================
# PREREQUISITES
# ============================================================================

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

# Resolve node binary directory (needed for launchd PATH)
NODE_BIN_DIR="$(dirname "$(which node)")"

echo "Node.js $(node -v) and pnpm $(pnpm -v) detected."
echo "Node binary directory: $NODE_BIN_DIR"
echo ""

# ============================================================================
# RUNNER SELECTION
# ============================================================================

echo "Select the default agent runner:"
echo "  1) openclaw  — OpenClaw gateway (requires running gateway + token)"
echo "  2) claude-cli — Claude Code CLI (uses Max subscription, no gateway needed)"
echo ""
read -rp "Runner [1]: " RUNNER_CHOICE
RUNNER_CHOICE="${RUNNER_CHOICE:-1}"

USES_OPENCLAW=false
USES_CLAUDE_CLI=false
OPENCLAW_TOKEN=""

if [ "$RUNNER_CHOICE" = "2" ]; then
  USES_CLAUDE_CLI=true
  echo ""
  echo "--- Claude CLI runner prerequisites ---"

  # Check claude binary
  if ! command -v claude &> /dev/null; then
    echo "Error: 'claude' binary not found on PATH." >&2
    echo "Install Claude Code: npm install -g @anthropic-ai/claude-code" >&2
    exit 1
  fi
  CLAUDE_BINARY="$(which claude)"
  echo "Claude CLI found: $CLAUDE_BINARY"

  # Check authentication
  AUTH_STATUS=$(claude /status 2>&1 || true)
  if echo "$AUTH_STATUS" | grep -q '"loggedIn": true'; then
    SUB_TYPE=$(echo "$AUTH_STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('subscriptionType','unknown'))" 2>/dev/null || echo "unknown")
    echo "Claude CLI authenticated (subscription: $SUB_TYPE)"
  else
    echo "Error: Claude CLI is not authenticated." >&2
    echo "Run 'claude login' first, then re-run this installer." >&2
    exit 1
  fi

  # Extract OAuth token
  OAUTH_TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" 2>/dev/null || true)
  if [ -z "$OAUTH_TOKEN" ]; then
    echo "Error: Could not extract OAuth token from Keychain." >&2
    echo "Make sure 'claude /status' shows loggedIn: true." >&2
    exit 1
  fi
  echo "OAuth token extracted from Keychain."

  # Check for ANTHROPIC_API_KEY pollution
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    echo ""
    echo "WARNING: ANTHROPIC_API_KEY is set in your environment."
    echo "The Claude CLI will bill to the API key instead of your Max subscription."
    echo "The installer will NOT include this in the service configuration."
    echo ""
    read -rp "Continue anyway? [y/N]: " CONTINUE
    if [ "$CONTINUE" != "y" ] && [ "$CONTINUE" != "Y" ]; then
      exit 1
    fi
  fi

  read -rp "Claude CLI working directory: " CLAUDE_WORK_DIR
  if [ -z "$CLAUDE_WORK_DIR" ]; then
    echo "Error: Working directory is required for the Claude CLI runner." >&2
    exit 1
  fi
  if [ ! -d "$CLAUDE_WORK_DIR" ]; then
    echo "Error: Directory does not exist: $CLAUDE_WORK_DIR" >&2
    exit 1
  fi

  echo ""
else
  USES_OPENCLAW=true
  read -rp "OPENCLAW_TOKEN: " OPENCLAW_TOKEN
  if [ -z "$OPENCLAW_TOKEN" ]; then
    echo "Error: OPENCLAW_TOKEN is required for the OpenClaw runner." >&2
    exit 1
  fi
fi

# ============================================================================
# GLOBAL CONFIGURATION
# ============================================================================

read -rp "REDIS_URL [redis://127.0.0.1:6379]: " REDIS_URL
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

read -rp "PORT [8792]: " PORT
PORT="${PORT:-8792}"

# ============================================================================
# PROVIDER COLLECTION
# ============================================================================

echo ""
echo "Configure webhook providers (at least one required)."
echo ""

PROVIDERS_JSON="["
PROVIDER_COUNT=0

while true; do
  echo "--- Provider $((PROVIDER_COUNT + 1)) ---"

  read -rp "Provider name (e.g., jira, github) [leave blank to finish]: " PROVIDER_NAME
  if [ -z "$PROVIDER_NAME" ]; then
    break
  fi

  read -rp "Route path [/hooks/$PROVIDER_NAME]: " ROUTE_PATH
  ROUTE_PATH="${ROUTE_PATH:-/hooks/$PROVIDER_NAME}"

  read -rp "HMAC secret: " HMAC_SECRET
  if [ -z "$HMAC_SECRET" ]; then
    echo "Error: HMAC secret is required for each provider." >&2
    continue
  fi

  read -rp "Signature strategy (websub, github, bearer, slack) [websub]: " SIG_STRATEGY
  SIG_STRATEGY="${SIG_STRATEGY:-websub}"

  if [ "$PROVIDER_COUNT" -gt 0 ]; then
    PROVIDERS_JSON+=","
  fi

  # Build runner config for this provider
  RUNNER_JSON=""
  if [ "$USES_CLAUDE_CLI" = true ]; then
    RUNNER_JSON=",\"runner\":{\"type\":\"claude-cli\",\"workDirectory\":\"$CLAUDE_WORK_DIR\",\"binary\":\"$CLAUDE_BINARY\"}"
  fi

  PROVIDERS_JSON+="{\"name\":\"$PROVIDER_NAME\",\"routePath\":\"$ROUTE_PATH\",\"hmacSecret\":\"$HMAC_SECRET\",\"signatureStrategy\":\"$SIG_STRATEGY\"$RUNNER_JSON,\"routing\":{\"default\":\"patch\"}}"
  PROVIDER_COUNT=$((PROVIDER_COUNT + 1))

  echo "Added provider: $PROVIDER_NAME ($ROUTE_PATH, $SIG_STRATEGY)"
  echo ""
done

PROVIDERS_JSON+="]"

if [ "$PROVIDER_COUNT" -eq 0 ]; then
  echo "Error: At least one provider is required." >&2
  exit 1
fi

echo ""
echo "$PROVIDER_COUNT provider(s) configured."
echo ""
echo "Building..."

# ============================================================================
# BUILD
# ============================================================================

pnpm install --frozen-lockfile
pnpm build

# ============================================================================
# INSTALL LAUNCHD SERVICE
# ============================================================================

INSTALL_PATH="$(pwd)"
PLIST_SRC="infra/launchd/com.openclaw.clawndom.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.openclaw.clawndom.plist"

# Unload existing service if present
if launchctl list | grep -q com.openclaw.clawndom 2>/dev/null; then
  echo "Unloading existing service..."
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

# Escape JSON for XML plist
PROVIDERS_CONFIG_ESCAPED="${PROVIDERS_JSON//\"/&quot;}"
PROVIDERS_CONFIG_SED_SAFE="${PROVIDERS_CONFIG_ESCAPED//&/\\&}"

# Configure plist
cp "$PLIST_SRC" "$PLIST_DST"
sed -i '' "s|__INSTALL_PATH__|$INSTALL_PATH|g" "$PLIST_DST"
sed -i '' "s|__HOME__|$HOME|g" "$PLIST_DST"
sed -i '' "s|__USER__|$(whoami)|g" "$PLIST_DST"
sed -i '' "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" "$PLIST_DST"
sed -i '' "s|__OPENCLAW_TOKEN__|${OPENCLAW_TOKEN:-unused}|g" "$PLIST_DST"
sed -i '' "s|__PROVIDERS_CONFIG__|$PROVIDERS_CONFIG_SED_SAFE|g" "$PLIST_DST"
sed -i '' "s|__REDIS_URL__|$REDIS_URL|g" "$PLIST_DST"
sed -i '' "s|__PORT__|$PORT|g" "$PLIST_DST"

# ============================================================================
# KEYCHAIN SETUP (Claude CLI runner)
# ============================================================================

if [ "$USES_CLAUDE_CLI" = true ]; then
  echo ""
  echo "Setting up keychain access for headless operation..."

  # Re-store any op tokens with universal access to prevent authorization popups
  for KEYCHAIN_ITEM in $(security dump-keychain 2>/dev/null | grep -o '"openclaw\.[^"]*"' | tr -d '"' | sort -u); do
    ITEM_VALUE=$(security find-generic-password -s "$KEYCHAIN_ITEM" -a "openclaw" -w 2>/dev/null || true)
    if [ -n "$ITEM_VALUE" ]; then
      security delete-generic-password -s "$KEYCHAIN_ITEM" -a "openclaw" 2>/dev/null || true
      security add-generic-password -s "$KEYCHAIN_ITEM" -a "openclaw" -w "$ITEM_VALUE" -T "" 2>/dev/null || true
      echo "  Updated keychain ACL: $KEYCHAIN_ITEM"
    fi
  done
fi

# ============================================================================
# LAUNCH
# ============================================================================

launchctl load "$PLIST_DST"

echo ""
echo "clawndom installed and running on port $PORT"
if [ "$USES_CLAUDE_CLI" = true ]; then
  echo "Runner: claude-cli (Max subscription)"
  echo "Working directory: $CLAUDE_WORK_DIR"
  echo ""
  echo "NOTE: The OAuth token is extracted from Keychain at service startup."
  echo "If you get 'Not logged in' errors, run: claude login"
  echo "Then restart: launchctl unload ~/Library/LaunchAgents/com.openclaw.clawndom.plist"
  echo "             launchctl load ~/Library/LaunchAgents/com.openclaw.clawndom.plist"
else
  echo "Runner: openclaw (gateway)"
fi
echo ""
echo "Next steps:"
echo "  1. Set up Tailscale Funnel for each provider:"
for i in $(seq 0 $((PROVIDER_COUNT - 1))); do
  ROUTE=$(echo "$PROVIDERS_JSON" | grep -o '"routePath":"[^"]*"' | sed -n "$((i + 1))p" | cut -d'"' -f4)
  echo "     tailscale funnel --bg --set-path $ROUTE $PORT"
done
echo "  2. Configure your webhook provider to point to https://<machine>.ts.net/hooks/<provider>"
echo "  3. Check health: curl http://localhost:$PORT/api/health"
