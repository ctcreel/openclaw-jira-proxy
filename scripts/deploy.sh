#!/usr/bin/env bash
#
# On-host Clawndom deploy. Runs as the `clawndom` user.
# Called by the GitHub Actions workflow over SSH and safe to run by hand.
#
# Steps:
#   1. git fetch + reset to origin/main
#   2. pnpm install --frozen-lockfile --prod=false
#   3. pnpm build
#   4. sudo systemctl restart clawndom (graceful handoff; systemd does the rest)
#   5. Verify /api/health returns 200

set -euo pipefail

REPO_DIR="/opt/clawndom"
HEALTH_URL="http://127.0.0.1:${PORT:-8793}/api/health"
HEALTH_TIMEOUT_SECONDS=30

log() { echo "[deploy] $*"; return 0; }

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "Expected a git checkout at ${REPO_DIR} — run bootstrap.sh first" >&2
  exit 1
fi

cd "${REPO_DIR}"

log "Fetching origin/main"
git fetch --prune origin main
git reset --hard origin/main

log "Installing dependencies (frozen lockfile)"
pnpm install --frozen-lockfile

log "Building"
pnpm build

# SPE-2000: refuse to restart against an env file that systemd will
# silently mis-parse. Catches the unquoted-JSON foot-gun before the
# service tries (and fails) to start.
log "Validating /etc/clawndom/clawndom.env"
sudo bash "${REPO_DIR}/infra/ec2/validate-env.sh" /etc/clawndom/clawndom.env

# Sync systemd unit when the in-repo copy diverges. bootstrap.sh installs
# the unit on first provision, but deploys are how all subsequent unit
# changes (MemoryMax, OOMPolicy, Restart=, etc.) reach existing hosts.
# Without this, infra/ec2/systemd/*.service edits are dead code.
REPO_UNIT="${REPO_DIR}/infra/ec2/systemd/clawndom.service"
LIVE_UNIT="/etc/systemd/system/clawndom.service"
if ! sudo cmp -s "${REPO_UNIT}" "${LIVE_UNIT}"; then
  log "Updating systemd unit (live copy differs from repo)"
  sudo install -m 0644 -o root -g root "${REPO_UNIT}" "${LIVE_UNIT}"
  sudo systemctl daemon-reload
fi

log "Restarting clawndom.service"
sudo systemctl restart clawndom.service

log "Waiting up to ${HEALTH_TIMEOUT_SECONDS}s for /api/health"
start=$(date +%s)
while true; do
  if curl -fsS -o /dev/null "${HEALTH_URL}"; then
    log "Health check passed"
    break
  fi
  elapsed=$(( $(date +%s) - start ))
  if [[ $elapsed -ge $HEALTH_TIMEOUT_SECONDS ]]; then
    echo "Health check failed after ${HEALTH_TIMEOUT_SECONDS}s" >&2
    sudo systemctl --no-pager status clawndom.service || true
    exit 1
  fi
  sleep 1
done

log "Deploy complete — commit $(git rev-parse --short HEAD)"
