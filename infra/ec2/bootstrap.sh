#!/usr/bin/env bash
#
# Clawndom EC2 bootstrap — run ONCE manually on a freshly provisioned
# instance. Idempotent enough that re-running is safe if a step fails
# partway through, but not intended as a configuration-management tool.
#
# Prereqs: Ubuntu 24.04, root/sudo access.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/SC0RED/clawndom/main/infra/ec2/bootstrap.sh | sudo bash
# or:
#   scp infra/ec2/bootstrap.sh ubuntu@clawndom:/tmp/
#   ssh ubuntu@clawndom 'sudo bash /tmp/bootstrap.sh'

set -euo pipefail

NODE_VERSION="22"
PNPM_VERSION="10.29.3"
# Overridable from env so the helpers can be exercised in a sandbox by
# tests/infra/bootstrap-ssh-provision.test.sh.
CLAWNDOM_USER="${CLAWNDOM_USER:-clawndom}"
CLAWNDOM_HOME="${CLAWNDOM_HOME:-/home/${CLAWNDOM_USER}}"
CLAWNDOM_REPO="${CLAWNDOM_REPO:-/opt/clawndom}"
CLAWNDOM_REPO_URL="https://github.com/SC0RED/clawndom.git"
CLAWNDOM_ENV_DIR="/etc/clawndom"
CLAWNDOM_LOG_DIR="/var/log/clawndom"
TAILSCALE_HOSTNAME="${TAILSCALE_HOSTNAME:-clawndom}"

# GitHub deploy-key provisioning (see provision_clawndom_github_auth).
# The clawndom user fetches /opt/clawndom from GitHub via SSH using a
# per-instance read-only deploy key — registered manually on the repo
# after bootstrap, surfaced in summary().
CLAWNDOM_SSH_HOST_ALIAS="github-clawndom"
CLAWNDOM_REPO_SSH_REMOTE="git@${CLAWNDOM_SSH_HOST_ALIAS}:SC0RED/clawndom.git"

log() { echo "[bootstrap] $*"; return 0; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "This script must run as root (use sudo)." >&2
    exit 1
  fi
  return 0
}

install_system_deps() {
  log "Updating apt + installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git redis-server jq unzip build-essential
  return 0
}

install_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    log "Tailscale already installed"
    return
  fi
  log "Installing Tailscale"
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
    | tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
    | tee /etc/apt/sources.list.d/tailscale.list >/dev/null
  apt-get update -y
  apt-get install -y tailscale
}

install_nodejs() {
  if command -v node >/dev/null 2>&1 && [[ "$(node -v)" == v${NODE_VERSION}* ]]; then
    log "Node.js ${NODE_VERSION} already installed"
    return
  fi
  log "Installing Node.js ${NODE_VERSION}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y nodejs
}

install_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    log "pnpm already installed ($(pnpm --version))"
    return
  fi
  log "Installing pnpm ${PNPM_VERSION}"
  npm install -g "pnpm@${PNPM_VERSION}"
}

install_claude_cli() {
  if command -v claude >/dev/null 2>&1; then
    log "Claude CLI already installed"
    return
  fi
  log "Installing Claude CLI"
  npm install -g @anthropic-ai/claude-code
}

install_op_cli() {
  if command -v op >/dev/null 2>&1; then
    log "1Password CLI already installed"
    return
  fi
  log "Installing 1Password CLI"
  curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
    | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" \
    > /etc/apt/sources.list.d/1password.list
  apt-get update -y
  apt-get install -y 1password-cli
}

create_clawndom_user() {
  if id "${CLAWNDOM_USER}" >/dev/null 2>&1; then
    log "${CLAWNDOM_USER} user already exists"
    return
  fi
  log "Creating ${CLAWNDOM_USER} system user"
  useradd --system --create-home --shell /bin/bash "${CLAWNDOM_USER}"
}

clone_repo() {
  if [[ -d "${CLAWNDOM_REPO}/.git" ]]; then
    log "Repo already cloned — fetching latest main"
    git -C "${CLAWNDOM_REPO}" fetch origin main
    git -C "${CLAWNDOM_REPO}" reset --hard origin/main
  else
    log "Cloning clawndom to ${CLAWNDOM_REPO}"
    git clone "${CLAWNDOM_REPO_URL}" "${CLAWNDOM_REPO}"
  fi
  chown -R "${CLAWNDOM_USER}:${CLAWNDOM_USER}" "${CLAWNDOM_REPO}"
  return 0
}

# Provision the GitHub deploy-auth artifacts for the ${CLAWNDOM_USER} runtime
# user so `git fetch origin main` works non-interactively from scripts/deploy.sh.
#
# Three artifacts, each guarded independently so a partially-provisioned
# instance (e.g. key generated but ~/.ssh/config wiped by hand) repairs
# correctly on re-run. Function-level "skip if key exists" would silently
# skip the missing pieces and leave the box broken.
#
# Operator step: the .pub side of the generated key has to be registered as
# a read-only deploy key on SC0RED/clawndom before scripts/deploy.sh runs.
# summary() prints the public key + a pointer to the GitHub UI.
provision_clawndom_github_auth() {
  log "Provisioning ${CLAWNDOM_USER} GitHub deploy auth"
  install -d -m 700 -o "${CLAWNDOM_USER}" -g "${CLAWNDOM_USER}" \
    "${CLAWNDOM_HOME}/.ssh"
  _provision_clawndom_deploy_key
  _provision_clawndom_ssh_config
  _provision_clawndom_known_hosts
  return 0
}

_provision_clawndom_deploy_key() {
  local key_path="${CLAWNDOM_HOME}/.ssh/clawndom_repo_deploy"
  if [[ -f "${key_path}" ]]; then
    log "Deploy key already present — skipping ssh-keygen"
    return 0
  fi
  log "Generating ed25519 deploy key for ${CLAWNDOM_USER}"
  sudo -u "${CLAWNDOM_USER}" ssh-keygen -t ed25519 -N "" \
    -C "${CLAWNDOM_USER}@$(hostname) clawndom-repo-deploy" \
    -f "${key_path}"
  return 0
}

_provision_clawndom_ssh_config() {
  local config_path="${CLAWNDOM_HOME}/.ssh/config"
  local key_path="${CLAWNDOM_HOME}/.ssh/clawndom_repo_deploy"
  local marker="Host ${CLAWNDOM_SSH_HOST_ALIAS}"
  if [[ -f "${config_path}" ]] && grep -qE "^${marker}\$" "${config_path}"; then
    log "SSH config already declares ${CLAWNDOM_SSH_HOST_ALIAS}"
    return 0
  fi
  log "Appending ${CLAWNDOM_SSH_HOST_ALIAS} block to ${config_path}"
  sudo -u "${CLAWNDOM_USER}" tee -a "${config_path}" >/dev/null <<EOF

${marker}
  HostName github.com
  User git
  IdentityFile ${key_path}
  IdentitiesOnly yes
EOF
  chmod 600 "${config_path}"
  return 0
}

_provision_clawndom_known_hosts() {
  local kh_path="${CLAWNDOM_HOME}/.ssh/known_hosts"
  if [[ -f "${kh_path}" ]] && grep -q "github.com" "${kh_path}"; then
    log "known_hosts already pinned for github.com"
    return 0
  fi
  log "Pinning github.com host keys via ssh-keyscan"
  ssh-keyscan -H github.com 2>/dev/null \
    | sudo -u "${CLAWNDOM_USER}" tee -a "${kh_path}" >/dev/null
  return 0
}

# Switch /opt/clawndom's origin to the SSH alias so subsequent `git fetch`
# calls (deploy.sh) authenticate with the deploy key. `git remote set-url`
# is unconditional — safe to re-run on an already-converted instance.
set_clawndom_remote_to_ssh_alias() {
  log "Setting ${CLAWNDOM_REPO} origin to ${CLAWNDOM_REPO_SSH_REMOTE}"
  sudo -u "${CLAWNDOM_USER}" git -C "${CLAWNDOM_REPO}" \
    remote set-url origin "${CLAWNDOM_REPO_SSH_REMOTE}"
  return 0
}

create_dirs() {
  log "Creating /etc + /var/log directories"
  mkdir -p "${CLAWNDOM_ENV_DIR}"
  chmod 750 "${CLAWNDOM_ENV_DIR}"
  chown root:"${CLAWNDOM_USER}" "${CLAWNDOM_ENV_DIR}"

  if [[ ! -f "${CLAWNDOM_ENV_DIR}/clawndom.env" ]]; then
    log "Creating empty ${CLAWNDOM_ENV_DIR}/clawndom.env — populate OP_SERVICE_ACCOUNT_TOKEN before start"
    touch "${CLAWNDOM_ENV_DIR}/clawndom.env"
    chmod 600 "${CLAWNDOM_ENV_DIR}/clawndom.env"
    chown root:"${CLAWNDOM_USER}" "${CLAWNDOM_ENV_DIR}/clawndom.env"
  fi

  mkdir -p "${CLAWNDOM_LOG_DIR}"
  chown -R "${CLAWNDOM_USER}:${CLAWNDOM_USER}" "${CLAWNDOM_LOG_DIR}"

  mkdir -p "${CLAWNDOM_HOME}/.openclaw" "${CLAWNDOM_HOME}/.clawndom/agents" "${CLAWNDOM_HOME}/.claude"
  chown -R "${CLAWNDOM_USER}:${CLAWNDOM_USER}" "${CLAWNDOM_HOME}"
  return 0
}

install_systemd_units() {
  log "Installing systemd units"
  install -m 0644 \
    "${CLAWNDOM_REPO}/infra/ec2/systemd/clawndom.service" \
    /etc/systemd/system/clawndom.service
  install -m 0644 \
    "${CLAWNDOM_REPO}/infra/ec2/systemd/clawndom-sync-agents.service" \
    /etc/systemd/system/clawndom-sync-agents.service
  install -m 0644 \
    "${CLAWNDOM_REPO}/infra/ec2/systemd/clawndom-sync-agents.timer" \
    /etc/systemd/system/clawndom-sync-agents.timer
  install -m 0644 \
    "${CLAWNDOM_REPO}/infra/ec2/systemd/clawndom-claude-refresh.service" \
    /etc/systemd/system/clawndom-claude-refresh.service
  install -m 0644 \
    "${CLAWNDOM_REPO}/infra/ec2/systemd/clawndom-claude-refresh.timer" \
    /etc/systemd/system/clawndom-claude-refresh.timer
  install -m 0644 \
    "${CLAWNDOM_REPO}/infra/ec2/systemd/clawndom-scarlett-handoff.service" \
    /etc/systemd/system/clawndom-scarlett-handoff.service
  install -m 0644 \
    "${CLAWNDOM_REPO}/infra/ec2/systemd/clawndom-scarlett-handoff.timer" \
    /etc/systemd/system/clawndom-scarlett-handoff.timer
  systemctl daemon-reload
  systemctl enable redis-server
  systemctl enable clawndom-sync-agents.timer
  systemctl start clawndom-sync-agents.timer
  systemctl enable clawndom-claude-refresh.timer
  systemctl start clawndom-claude-refresh.timer
  systemctl enable clawndom-scarlett-handoff.timer
  systemctl start clawndom-scarlett-handoff.timer
  return 0
}

configure_redis() {
  log "Binding Redis to localhost only"
  sed -i 's/^bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf
  sed -i 's/^# *protected-mode .*/protected-mode yes/' /etc/redis/redis.conf
  systemctl restart redis-server
  return 0
}

summary() {
  local pub_key_path="${CLAWNDOM_HOME}/.ssh/clawndom_repo_deploy.pub"
  local pub_key="(deploy key not yet generated — re-run bootstrap.sh)"
  if [[ -f "${pub_key_path}" ]]; then
    pub_key="$(cat "${pub_key_path}")"
  fi
  cat <<EOF

────────────────────────────────────────────
Bootstrap complete.

REQUIRED before first deploy — register this read-only deploy key on
https://github.com/SC0RED/clawndom/settings/keys/new (uncheck "Allow write
access"). Without this, scripts/deploy.sh will fail at 'git fetch origin'
because the ${CLAWNDOM_USER} user has no GitHub creds:

${pub_key}

Next steps (run as root):
  1. tailscale up --hostname=${TAILSCALE_HOSTNAME}
  2. Populate /etc/clawndom/clawndom.env with OP_SERVICE_ACCOUNT_TOKEN
     and any other non-1Password secrets.
  3. sudo -u ${CLAWNDOM_USER} claude login
       (one-time — establishes file-based credentials for the runner)
  4. sudo -u ${CLAWNDOM_USER} bash ${CLAWNDOM_REPO}/scripts/sync-agents.sh
       (seeds ${CLAWNDOM_HOME}/.clawndom/agents/ with the-agency clone)
  5. sudo -u ${CLAWNDOM_USER} bash ${CLAWNDOM_REPO}/scripts/deploy.sh
       (installs deps, builds, starts the service)
  6. curl http://localhost:8793/api/health

────────────────────────────────────────────
EOF
  return 0
}

main() {
  require_root
  install_system_deps
  install_tailscale
  install_nodejs
  install_pnpm
  install_claude_cli
  install_op_cli
  create_clawndom_user
  clone_repo
  provision_clawndom_github_auth
  set_clawndom_remote_to_ssh_alias
  create_dirs
  install_systemd_units
  configure_redis
  summary
  return 0
}

# Source-friendly: only run main() when invoked directly. Sourcing the
# script (tests/infra/bootstrap-ssh-provision.test.sh) gets the helper
# functions without triggering the require_root guard.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
