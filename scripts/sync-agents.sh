#!/usr/bin/env bash
#
# Refresh every agent repo under CLAWNDOM_CONFIG_DIR with a fast-forward pull.
# Invoked periodically by `clawndom-sync-agents.timer` (systemd).
#
# Exits 0 on success, non-zero on any per-repo failure so the timer surfaces
# the problem in journald instead of silently drifting.

set -euo pipefail

CONFIG_DIR="${CLAWNDOM_CONFIG_DIR:-$HOME/.clawndom/agents}"

if [[ ! -d "$CONFIG_DIR" ]]; then
  echo "sync-agents: CLAWNDOM_CONFIG_DIR does not exist: $CONFIG_DIR" >&2
  exit 1
fi

shopt -s nullglob
repos=("$CONFIG_DIR"/*/)
shopt -u nullglob

if [[ ${#repos[@]} -eq 0 ]]; then
  echo "sync-agents: no agent repos found under $CONFIG_DIR"
  exit 0
fi

failed=0
for repo_dir in "${repos[@]}"; do
  repo_dir="${repo_dir%/}"
  if [[ ! -d "$repo_dir/.git" ]]; then
    echo "sync-agents: skipping non-git directory: $repo_dir"
    continue
  fi

  echo "sync-agents: pulling $repo_dir"
  if ! git -C "$repo_dir" pull --ff-only --quiet; then
    echo "sync-agents: pull failed for $repo_dir" >&2
    failed=$((failed + 1))
  fi
done

if [[ $failed -gt 0 ]]; then
  echo "sync-agents: $failed repo(s) failed to sync" >&2
  exit 1
fi
