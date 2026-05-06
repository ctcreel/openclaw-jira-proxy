#!/usr/bin/env bash
#
# Regression test for SPE-2005: clawndom.service must declare a start-rate
# cap and a tmpfs RuntimeDirectory= so a persistent startup failure cannot
# DDoS downstream secret providers.
#
# What this asserts on `infra/ec2/systemd/clawndom.service`:
#   - StartLimitIntervalSec=300
#   - StartLimitBurst=5
#   - RuntimeDirectory=clawndom
#   - RuntimeDirectoryMode=0700
#   - RuntimeDirectoryPreserve=restart
#
#   - Restart=on-failure OR Restart=always (some restart policy is required;
#     removing it without a separate health-management story would defeat
#     the cap).
#   - RestartSec=5 (kept for the math: 5 attempts × 5s = ~25s before the
#     unit hits start-limit-hit, fast enough that a real outage is detected
#     quickly but slow enough that systemd's start-limit gate is reachable).
#
# Without these directives, a clawndom crash loop becomes ~720 restarts/hour,
# each re-shelling every secret resolver. That's the failure pattern from
# the May-2 incident — a single broken Redis URL took the agency offline by
# rate-limiting the 1Password service account.
#
# Style matches tests/infra/bootstrap-ssh-provision.test.sh — pure bash, no
# harness dependencies. Runs as part of `make test-infra`.
#
# Run directly:
#   bash tests/infra/clawndom-systemd-start-limit.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
UNIT_FILE="${REPO_ROOT}/infra/ec2/systemd/clawndom.service"

if [[ ! -f "${UNIT_FILE}" ]]; then
  echo "FAIL: cannot find ${UNIT_FILE}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

PASS_COUNT=0
FAIL_COUNT=0
CURRENT_TEST=""

start_test() {
  CURRENT_TEST="$1"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "  ✓ ${CURRENT_TEST}"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "  ✗ ${CURRENT_TEST}: $1" >&2
}

# Assert that a key=value directive appears verbatim somewhere in the unit
# file. Match is anchored to start-of-line so a comment containing the same
# text doesn't satisfy the assertion.
assert_directive() {
  local key="$1"
  local value="$2"
  local pattern="^${key}=${value}$"
  if grep -qE "${pattern}" "${UNIT_FILE}"; then
    pass
  else
    fail "missing directive: ${key}=${value}"
  fi
}

# Assert that a key= directive matches one of several possible values
# (used for Restart= where on-failure or always are both acceptable).
assert_directive_any_of() {
  local key="$1"
  shift
  local found=0
  for value in "$@"; do
    if grep -qE "^${key}=${value}$" "${UNIT_FILE}"; then
      found=1
      break
    fi
  done
  if [[ ${found} -eq 1 ]]; then
    pass
  else
    fail "missing directive: ${key}=<one of: $*>"
  fi
}

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

echo "Running SPE-2005 systemd start-limit + RuntimeDirectory regression tests…"

start_test "StartLimitIntervalSec=300 declared (start-rate cap window)"
assert_directive "StartLimitIntervalSec" "300"

start_test "StartLimitBurst=5 declared (max attempts inside the cap window)"
assert_directive "StartLimitBurst" "5"

start_test "RuntimeDirectory=clawndom declared (tmpfs for secrets cache)"
assert_directive "RuntimeDirectory" "clawndom"

start_test "RuntimeDirectoryMode=0700 declared (cache directory mode)"
assert_directive "RuntimeDirectoryMode" "0700"

start_test "RuntimeDirectoryPreserve=restart declared (cache survives systemctl restart, wiped on stop)"
assert_directive "RuntimeDirectoryPreserve" "restart"

start_test "RestartSec=5 unchanged (5 attempts × 5s lands inside the 300s window)"
assert_directive "RestartSec" "5"

start_test "Restart= policy still set (cap without a restart policy is meaningless)"
assert_directive_any_of "Restart" "on-failure" "always"

# ---------------------------------------------------------------------------
# Negative test — guard against a future edit silently re-opening the gate.
# ---------------------------------------------------------------------------

start_test "RuntimeDirectoryPreserve is NOT set to 'yes' (would leave secrets at rest after stop)"
if grep -qE '^RuntimeDirectoryPreserve=yes$' "${UNIT_FILE}"; then
  fail "RuntimeDirectoryPreserve=yes leaves /run/clawndom on disk after systemctl stop — must be 'restart'"
else
  pass
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
if [[ ${FAIL_COUNT} -gt 0 ]]; then
  exit 1
fi
exit 0
