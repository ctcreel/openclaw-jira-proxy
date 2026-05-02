#!/usr/bin/env bash
#
# validate-env.sh — pre-flight check for /etc/clawndom/clawndom.env.
#
# WHY
#   systemd's EnvironmentFile= parser uses POSIX-shell-style quoting:
#   unquoted values containing literal " characters get the quote chars
#   stripped during parse, and JSON-valued env vars reach the process
#   either malformed or undefined. This script asks systemd to do its
#   real parse — via a transient unit — then asserts that the four
#   JSON-valued env vars survive as non-empty JSON arrays.
#
#   See SPE-2000 for the production outage that motivated this gate.
#
# USAGE
#   sudo bash validate-env.sh [/path/to/clawndom.env]
#
#   Exits 0 on success. On failure, prints which key is malformed/missing
#   and the operator-facing fix, then exits 1.
#
# CALLED BY
#   - scripts/deploy.sh (before `systemctl restart`)
#   - operators running a manual self-check after editing the env file

set -euo pipefail

ENV_FILE="${1:-/etc/clawndom/clawndom.env}"

# Required JSON-valued env vars — each must parse as a non-empty JSON array
# after systemd reads the EnvironmentFile=. ADD NEW JSON-VALUED ENV VARS
# HERE — see SPE-2000. (If you add a key whose runtime contract permits an
# empty array, split this list and adjust the JQ_NONEMPTY check below.)
REQUIRED_JSON_KEYS=(
  PROVIDERS_CONFIG
  AGENTS_CONFIG
  SECRETS_PROVIDERS_CONFIG
  SECRETS_CONFIG
)

# jq filter: true iff the input parses as a JSON array with at least one element
JQ_NONEMPTY='if type == "array" and length > 0 then true else error("not a non-empty array") end'

log() { echo "[validate-env] $*"; }
err() { echo "[validate-env] ERROR: $*" >&2; }

require_tools() {
  local missing=()
  for tool in systemd-run jq awk; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      missing+=("${tool}")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    err "missing required tools: ${missing[*]}"
    exit 1
  fi
}

require_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    err "env file not found: ${ENV_FILE}"
    exit 1
  fi
  if [[ ! -r "${ENV_FILE}" ]]; then
    err "env file not readable by current user: ${ENV_FILE}"
    exit 1
  fi
}

# Run a transient systemd unit that consumes the env file and prints the
# resulting environment. We capture stdout; any value here has already been
# through systemd's parser, so the round-trip mirrors what the real
# clawndom.service will see at start.
capture_systemd_env() {
  systemd-run \
    --quiet \
    --collect \
    --pipe \
    --wait \
    --property="EnvironmentFile=${ENV_FILE}" \
    /usr/bin/env
}

# Extract the value for KEY from the captured `env` output. systemd-run's
# /usr/bin/env emits one VAR=VALUE per line. Values themselves may contain
# newlines if the env file used line-continuations, but the four
# JSON-valued env vars in scope are single-line.
extract_value() {
  local key="$1"
  local captured="$2"
  awk -v key="${key}" 'BEGIN { FS = "=" } $1 == key { sub(/^[^=]+=/, ""); print; exit }' <<< "${captured}"
}

main() {
  require_tools
  require_file

  log "Validating ${ENV_FILE} via systemd-run"

  local captured
  if ! captured="$(capture_systemd_env)"; then
    err "systemd-run failed to read ${ENV_FILE}"
    err "(does the calling user have system-bus access? try: sudo bash $0 ${ENV_FILE})"
    exit 1
  fi

  local failures=0
  for key in "${REQUIRED_JSON_KEYS[@]}"; do
    # Detect "key not present at all in the parsed env" separately from
    # "key present but its value is malformed" — different operator fixes.
    if ! awk -v key="${key}" 'BEGIN { FS = "=" } $1 == key { found=1 } END { exit found ? 0 : 1 }' <<< "${captured}"; then
      err "${key} is missing from the parsed env"
      err "  fix: add ${key}='[...]' to ${ENV_FILE} (single-quoted JSON array)"
      failures=$(( failures + 1 ))
      continue
    fi

    local value
    value="$(extract_value "${key}" "${captured}")"

    # Defensive: an empty value here means systemd parsed the line but the
    # value is zero-length. Most commonly that's the unquoted-JSON bug —
    # the parser stripped " chars and then collapsed remaining content.
    if [[ -z "${value}" ]]; then
      err "${key} parsed as empty by systemd — almost certainly an unquoted JSON value"
      err "  fix: wrap the value in single quotes: ${key}='[...]' in ${ENV_FILE}"
      failures=$(( failures + 1 ))
      continue
    fi

    if ! jq -e "${JQ_NONEMPTY}" <<< "${value}" >/dev/null 2>&1; then
      # jq fails for two distinct reasons: (a) value is not valid JSON
      # (likely the unquoted-quote-stripping bug), or (b) value is
      # valid JSON but is the empty array / not-an-array. Either way the
      # contract requires a non-empty JSON array.
      if jq -e '.' <<< "${value}" >/dev/null 2>&1; then
        err "${key} parsed as valid JSON but is not a non-empty array"
        err "  fix: ${key}='[<at least one entry>]' — see docs/guides/ENVIRONMENT_VARIABLES.md"
      else
        err "${key} parsed as malformed JSON — almost certainly an unquoted value"
        err "  fix: wrap the value in single quotes: ${key}='[...]' in ${ENV_FILE}"
      fi
      failures=$(( failures + 1 ))
    fi
  done

  if (( failures > 0 )); then
    err "${failures} validation failure(s) — refusing to proceed"
    exit 1
  fi

  log "All ${#REQUIRED_JSON_KEYS[@]} required JSON-valued env vars parse as non-empty arrays"
}

main "$@"
