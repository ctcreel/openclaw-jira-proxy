#!/usr/bin/env bash
#
# Self-update for a clawndom-N deployment. Pulls clawndom main, runs
# `pnpm install --frozen-lockfile` and `pnpm build`, then restarts the
# service ONLY when the build actually produced new artifacts.
#
# Designed to be invoked by a systemd timer (see
# `clawndom-self-update.service`/.timer). The corresponding
# `clawndom-sync-agents` pair already handles the agent workspaces
# (winston-agency, agency-tools); this script handles the clawndom
# runtime itself.
#
# Required env:
#   CLAWNDOM_REPO_DIR    — clone of clawndom on this host (e.g.
#                          /home/ubuntu/clawndom-winston).
#   CLAWNDOM_SERVICE     — name of the systemd unit to restart on a
#                          successful build (e.g. clawndom-winston).
#
# Exit codes:
#   0  — no update was needed, OR update succeeded.
#   1  — pull, install, or build failed (no restart attempted).
#   2  — restart attempted but the unit failed to come back up.

set -euo pipefail

REPO_DIR="${CLAWNDOM_REPO_DIR:?CLAWNDOM_REPO_DIR must be set}"
SERVICE="${CLAWNDOM_SERVICE:?CLAWNDOM_SERVICE must be set}"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "self-update: $REPO_DIR is not a git repository" >&2
  exit 1
fi

cd "$REPO_DIR"

BEFORE_SHA=$(git rev-parse HEAD)
echo "self-update: current HEAD $BEFORE_SHA"

git fetch --quiet origin main
TARGET_SHA=$(git rev-parse origin/main)

if [[ "$BEFORE_SHA" == "$TARGET_SHA" ]]; then
  echo "self-update: already at origin/main; nothing to do"
  exit 0
fi

echo "self-update: fast-forwarding to $TARGET_SHA"
git pull --ff-only --quiet origin main

echo "self-update: pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "self-update: pnpm build"
pnpm build

AFTER_SHA=$(git rev-parse HEAD)
if [[ "$AFTER_SHA" == "$BEFORE_SHA" ]]; then
  echo "self-update: post-build HEAD unchanged from $BEFORE_SHA — refusing to restart"
  exit 0
fi

echo "self-update: restarting $SERVICE"
if ! sudo systemctl restart "$SERVICE"; then
  echo "self-update: systemctl restart failed" >&2
  exit 2
fi

# Give the service a beat to either come up or fail. 30s matches the boot
# behavior observed today (agent-loader does git pulls + secret resolution
# before the listener binds).
sleep 30

STATE=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
if [[ "$STATE" != "active" ]]; then
  echo "self-update: $SERVICE is not active after restart (state=$STATE)" >&2
  echo "self-update: recent journal entries:" >&2
  journalctl -u "$SERVICE" --since "1 minute ago" --no-pager | tail -50 >&2
  exit 2
fi

echo "self-update: $SERVICE is active at $AFTER_SHA"
