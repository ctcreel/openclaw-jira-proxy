#!/usr/bin/env bash
#
# Tailscale Funnel route configuration — single source of truth for the
# paths the public clawndom URL exposes. Idempotent: re-running replaces
# the prior configuration so the box's funnel state matches this file
# exactly.
#
# Add a new route here BEFORE merging code that depends on it being
# reachable through the funnel. Forgetting this step is how the dashboard
# ends up showing "?" for half its panels — an endpoint exists in code
# but 404s through the public URL.
#
# Usage:
#   sudo bash /opt/clawndom/infra/ec2/configure-tailscale-funnel.sh
#
# Verify with:
#   tailscale funnel status
#   tailscale serve status

set -euo pipefail

# Production clawndom binds 8793 via PORT in /etc/clawndom/clawndom.env
# (the src/config.ts default of 8792 is overridden in the deployed env).
# Dashboard.py uses the same 8793 default. Override here if a non-production
# host runs on the code default port.
CLAWNDOM_LOCAL_BASE="${CLAWNDOM_LOCAL_BASE:-http://127.0.0.1:8793}"

# Ordered list of public path → local target mappings. Every endpoint a
# remote client (dashboard, webhook, health probe) needs MUST appear here.
ROUTES=(
  # Webhook ingestion — Jira and Slack delivery URLs.
  "/hooks/jira"
  "/hooks/slack"
  # Health probe — used by uptime monitors and the dashboard's status LED.
  "/api/health"
  # Live event stream — the dashboard's persistent SSE connection.
  "/api/events"
  # Bootstrap endpoints — the dashboard hits these on connect to seed
  # active/queued/recent panels and the SSE replay anchor. Adding a new
  # bootstrap fetch in the dashboard without adding it here is the most
  # common cause of "?" in dashboard panels.
  "/api/jobs/active"
  "/api/queue/snapshot"
  "/api/webhooks/skipped/recent"
)

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "This script must run as root (use sudo)." >&2
    exit 1
  fi
}

require_root

# Reset first so removed routes actually disappear. Without reset, a route
# deleted from this script's list would linger on the box.
echo "[funnel] Resetting current funnel configuration"
tailscale funnel reset

for path in "${ROUTES[@]}"; do
  echo "[funnel] Setting ${path} -> ${CLAWNDOM_LOCAL_BASE}${path}"
  tailscale funnel --bg --set-path "${path}" "${CLAWNDOM_LOCAL_BASE}${path}"
done

echo
echo "[funnel] Final configuration:"
tailscale funnel status
