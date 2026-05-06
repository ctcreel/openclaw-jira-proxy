#!/usr/bin/env bash
#
# Test suite for scripts/check_branch_name.sh — the husky pre-push hook
# AND the CI Naming Validation / Branch Name check both delegate to that
# script, so its acceptance set IS the project's branch-naming policy.
#
# Run directly:
#   bash tests/infra/check-branch-name.test.sh

set -u  # do NOT use -e; we expect some assertions to flip the script's exit status

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TARGET="${REPO_ROOT}/scripts/check_branch_name.sh"

if [[ ! -f "${TARGET}" ]]; then
  echo "FAIL: cannot find ${TARGET}" >&2
  exit 1
fi

PASS_COUNT=0
FAIL_COUNT=0

# Shell out via env-var override so the script doesn't have to consult git
# state. The script's branch-resolution prefers GITHUB_HEAD_REF when set.
run_check() {
  local branch="$1"
  GITHUB_HEAD_REF="${branch}" GITHUB_REF="" bash "${TARGET}" >/dev/null 2>&1
  echo $?
}

assert_accepts() {
  local branch="$1"
  local exit_code
  exit_code="$(run_check "${branch}")"
  if [[ "${exit_code}" == "0" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  ok: accepts ${branch}"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  FAIL: rejected ${branch} (expected accept)" >&2
  fi
}

assert_rejects() {
  local branch="$1"
  local exit_code
  exit_code="$(run_check "${branch}")"
  if [[ "${exit_code}" != "0" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  ok: rejects ${branch}"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  FAIL: accepted ${branch} (expected reject)" >&2
  fi
}

echo "── long-lived branches"
assert_accepts "main"
assert_accepts "development"
assert_accepts "testing"
assert_accepts "demo"
assert_accepts "production"

echo "── conventional-commits-aligned types with ticket"
assert_accepts "feat/SPE-1234-add-thing"
assert_accepts "fix/SPE-1234-fix-thing"
assert_accepts "feature/SPE-1234-old-style-also-fine"
assert_accepts "bugfix/SPE-1234-old-style-also-fine"
assert_accepts "hotfix/SPE-1234-prod-fire"
assert_accepts "docs/SPE-1234-update-readme"
assert_accepts "style/SPE-1234-prettier"
assert_accepts "refactor/SPE-1234-extract"
assert_accepts "perf/SPE-1234-cache"
assert_accepts "test/SPE-1234-coverage"
assert_accepts "build/SPE-1234-deps"
assert_accepts "ci/SPE-1234-workflow"
assert_accepts "chore/SPE-1234-cleanup"
assert_accepts "revert/SPE-1234-rollback"

echo "── ticket-optional path (the new escape hatch)"
assert_accepts "fix/dashboard-context-and-funnel-routes"
assert_accepts "chore/relax-branch-name-rule"
assert_accepts "docs/no-stop-on-account-swap"
assert_accepts "feat/quota-aware-pause"

echo "── multi-letter ticket prefixes still work"
assert_accepts "fix/SF-42-platform-bug"
assert_accepts "feat/AB-1-shortest-valid"

echo "── rejected: type not in vocabulary"
assert_rejects "wip/SPE-1234-something"
assert_rejects "experimental/SPE-1234-x"
assert_rejects "tmp/something"

echo "── rejected: malformed description"
assert_rejects "fix/SPE-1234-"
assert_rejects "fix/SPE-1234-double--hyphen"
assert_rejects "chore/trailing-"
assert_rejects "chore/double--hyphen"
assert_rejects "fix/Up-Per-Case"
assert_rejects "fix/-leading-hyphen"
assert_rejects "fix/x"             # too short (< 3 chars)
assert_rejects "fix/SPE-1234-x"    # description after ticket too short

echo "── rejected: structural"
assert_rejects "no-prefix-at-all"
assert_rejects "/empty-type"
assert_rejects "fix/"
assert_rejects "fix"

echo
echo "Result: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  exit 1
fi
exit 0
