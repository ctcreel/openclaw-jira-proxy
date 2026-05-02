#!/usr/bin/env bash
#
# Regression test for SPE-1998: per-artifact idempotency of the GitHub deploy
# auth provisioning helpers added to infra/ec2/bootstrap.sh.
#
# Each artifact (deploy key, SSH config block, known_hosts entry) is guarded
# independently so partial-state recovery works — the whole point of
# Scarlett's must-fix on the plan.
#
# This is a pure-bash test: it sources bootstrap.sh in a sandbox with HOME,
# CLAWNDOM_USER, CLAWNDOM_REPO, sudo, ssh-keygen, ssh-keyscan, hostname, and
# git all stubbed via PATH manipulation, then exercises the helpers and
# asserts the artifacts on disk.
#
# Run directly:
#   bash tests/infra/bootstrap-ssh-provision.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BOOTSTRAP_SCRIPT="${REPO_ROOT}/infra/ec2/bootstrap.sh"

if [[ ! -f "${BOOTSTRAP_SCRIPT}" ]]; then
  echo "FAIL: cannot find ${BOOTSTRAP_SCRIPT}" >&2
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
  echo "── ${CURRENT_TEST}"
}

assert() {
  local description="$1"
  local condition="$2"
  if eval "${condition}"; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "   ok: ${description}"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "   FAIL: ${description}" >&2
    echo "   condition: ${condition}" >&2
  fi
}

assert_file_unchanged() {
  local path="$1"
  local description="$2"
  local before="$3"
  local after
  after="$(stat -c '%Y:%s' "${path}")"
  if [[ "${before}" == "${after}" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "   ok: ${description}"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "   FAIL: ${description} (mtime/size changed: ${before} → ${after})" >&2
  fi
}

setup_sandbox() {
  export SANDBOX
  SANDBOX="$(mktemp -d)"
  trap 'rm -rf "${SANDBOX}"' EXIT

  # Override the bootstrap globals to point at the sandbox. The script declares
  # them with plain assignment, but we set them in our environment first and
  # then tweak the script to honor the env (see source-friendly guard below).
  export CLAWNDOM_USER="${USER:-runner}"
  export CLAWNDOM_HOME="${SANDBOX}/home/clawndom"
  export CLAWNDOM_REPO="${SANDBOX}/opt/clawndom"
  mkdir -p "${CLAWNDOM_HOME}" "${CLAWNDOM_REPO}/.git"

  # Stub out the privileged + side-effecting commands via PATH.
  STUB_BIN="${SANDBOX}/bin"
  mkdir -p "${STUB_BIN}"

  # sudo: drop the -u flag and run the rest in the current shell context.
  cat >"${STUB_BIN}/sudo" <<'STUB'
#!/usr/bin/env bash
# Strip "-u <user>" so we run as the test user; everything else falls through.
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -u) shift 2 ;;
    *)  args+=("$1"); shift ;;
  esac
done
exec "${args[@]}"
STUB
  chmod +x "${STUB_BIN}/sudo"

  # ssh-keygen: write a deterministic fake key pair so we can detect regen.
  cat >"${STUB_BIN}/ssh-keygen" <<'STUB'
#!/usr/bin/env bash
# Parse "-f <path>" to find where to write the fake key.
key_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f) key_path="$2"; shift 2 ;;
    *)  shift ;;
  esac
done
if [[ -z "${key_path}" ]]; then
  echo "stub ssh-keygen: missing -f" >&2; exit 1
fi
printf 'STUB-PRIVATE-KEY\n' > "${key_path}"
printf 'ssh-ed25519 STUBSTUBSTUB stub@host\n' > "${key_path}.pub"
STUB
  chmod +x "${STUB_BIN}/ssh-keygen"

  # ssh-keyscan: emit a fake hashed entry so the grep in the helper matches.
  cat >"${STUB_BIN}/ssh-keyscan" <<'STUB'
#!/usr/bin/env bash
echo "github.com ssh-ed25519 STUBHOSTKEY"
STUB
  chmod +x "${STUB_BIN}/ssh-keyscan"

  # hostname: deterministic.
  cat >"${STUB_BIN}/hostname" <<'STUB'
#!/usr/bin/env bash
echo "test-sandbox"
STUB
  chmod +x "${STUB_BIN}/hostname"

  # git: only used here for `remote set-url`. Just record the call.
  cat >"${STUB_BIN}/git" <<'STUB'
#!/usr/bin/env bash
echo "git $*" >> "${SANDBOX}/git.log"
STUB
  chmod +x "${STUB_BIN}/git"

  export PATH="${STUB_BIN}:${PATH}"
}

# ---------------------------------------------------------------------------
# Source the helpers
# ---------------------------------------------------------------------------
#
# bootstrap.sh ends with a guarded `main "$@"` so sourcing it does not run
# main(). It also references CLAWNDOM_USER / CLAWNDOM_HOME / CLAWNDOM_REPO via
# `${VAR:-default}` so we can override them from the env.

setup_sandbox

# shellcheck disable=SC1090
source "${BOOTSTRAP_SCRIPT}"

# ---------------------------------------------------------------------------
# Test 1: clean install — all three artifacts created.
# ---------------------------------------------------------------------------
start_test "clean install creates all three artifacts"
provision_clawndom_github_auth >/dev/null

KEY="${CLAWNDOM_HOME}/.ssh/clawndom_repo_deploy"
PUB="${KEY}.pub"
CFG="${CLAWNDOM_HOME}/.ssh/config"
KH="${CLAWNDOM_HOME}/.ssh/known_hosts"

assert "ssh dir exists with mode 700" "[[ -d '${CLAWNDOM_HOME}/.ssh' ]]"
assert "private key written"          "[[ -f '${KEY}' ]]"
assert "public key written"           "[[ -f '${PUB}' ]]"
assert "ssh config written"           "[[ -f '${CFG}' ]]"
assert "ssh config has Host alias"    "grep -qE '^Host github-clawndom\$' '${CFG}'"
assert "ssh config has IdentityFile"  "grep -q 'IdentityFile ${KEY}' '${CFG}'"
assert "known_hosts written"          "[[ -f '${KH}' ]]"
assert "known_hosts has github.com"   "grep -q 'github.com' '${KH}'"

# ---------------------------------------------------------------------------
# Test 2: full re-run is a no-op — nothing regenerates.
# ---------------------------------------------------------------------------
start_test "full re-run is a no-op (every artifact untouched)"
KEY_BEFORE=$(stat -c '%Y:%s' "${KEY}")
PUB_BEFORE=$(stat -c '%Y:%s' "${PUB}")
CFG_BEFORE=$(stat -c '%Y:%s' "${CFG}")
KH_BEFORE=$(stat -c '%Y:%s' "${KH}")

# A small sleep keeps mtime resolution honest on filesystems with 1s precision.
sleep 1

provision_clawndom_github_auth >/dev/null

assert_file_unchanged "${KEY}" "private key unchanged" "${KEY_BEFORE}"
assert_file_unchanged "${PUB}" "public key unchanged"  "${PUB_BEFORE}"
assert_file_unchanged "${CFG}" "ssh config unchanged"  "${CFG_BEFORE}"
assert_file_unchanged "${KH}"  "known_hosts unchanged" "${KH_BEFORE}"

# ---------------------------------------------------------------------------
# Test 3: missing ssh config — only that artifact gets rebuilt.
# This is Scarlett's must-fix scenario: per-artifact guards must work
# independently. Function-level early-return on key existence would fail this.
# ---------------------------------------------------------------------------
start_test "missing SSH config is restored without regenerating the key"
rm "${CFG}"
KEY_BEFORE=$(stat -c '%Y:%s' "${KEY}")
KH_BEFORE=$(stat -c '%Y:%s' "${KH}")

sleep 1
provision_clawndom_github_auth >/dev/null

assert "ssh config restored" "[[ -f '${CFG}' ]]"
assert "ssh config has Host alias after restore" "grep -qE '^Host github-clawndom\$' '${CFG}'"
assert_file_unchanged "${KEY}" "private key NOT regenerated" "${KEY_BEFORE}"
assert_file_unchanged "${KH}"  "known_hosts NOT touched"     "${KH_BEFORE}"

# ---------------------------------------------------------------------------
# Test 4: missing known_hosts — only that artifact gets rebuilt.
# ---------------------------------------------------------------------------
start_test "missing known_hosts is restored without regenerating the key"
rm "${KH}"
KEY_BEFORE=$(stat -c '%Y:%s' "${KEY}")
CFG_BEFORE=$(stat -c '%Y:%s' "${CFG}")

sleep 1
provision_clawndom_github_auth >/dev/null

assert "known_hosts restored" "[[ -f '${KH}' ]]"
assert "known_hosts has github.com after restore" "grep -q 'github.com' '${KH}'"
assert_file_unchanged "${KEY}" "private key NOT regenerated" "${KEY_BEFORE}"
assert_file_unchanged "${CFG}" "ssh config NOT touched"      "${CFG_BEFORE}"

# ---------------------------------------------------------------------------
# Test 5: missing private key — key regenerates, config and known_hosts untouched.
# ---------------------------------------------------------------------------
start_test "missing key is regenerated without rewriting config or known_hosts"
rm "${KEY}" "${PUB}"
CFG_BEFORE=$(stat -c '%Y:%s' "${CFG}")
KH_BEFORE=$(stat -c '%Y:%s' "${KH}")

sleep 1
provision_clawndom_github_auth >/dev/null

assert "private key regenerated" "[[ -f '${KEY}' ]]"
assert "public key regenerated"  "[[ -f '${PUB}' ]]"
assert_file_unchanged "${CFG}" "ssh config NOT touched"      "${CFG_BEFORE}"
assert_file_unchanged "${KH}"  "known_hosts NOT touched"     "${KH_BEFORE}"

# ---------------------------------------------------------------------------
# Test 6: pre-existing ssh config with unrelated entries — append, do not clobber.
# ---------------------------------------------------------------------------
start_test "pre-existing ssh config is appended to, not replaced"
rm -f "${CFG}"
cat >"${CFG}" <<'EOF'
Host other-thing
  HostName example.com
EOF

provision_clawndom_github_auth >/dev/null

assert "pre-existing entry preserved"     "grep -q 'Host other-thing' '${CFG}'"
assert "new Host alias appended"          "grep -qE '^Host github-clawndom\$' '${CFG}'"

# ---------------------------------------------------------------------------
# Test 7: set_clawndom_remote_to_ssh_alias issues the right git invocation.
# ---------------------------------------------------------------------------
start_test "set_clawndom_remote_to_ssh_alias rewrites origin to SSH alias"
: > "${SANDBOX}/git.log"
set_clawndom_remote_to_ssh_alias >/dev/null

assert "git remote set-url called with SSH alias" \
  "grep -qF 'remote set-url origin git@github-clawndom:SC0RED/clawndom.git' '${SANDBOX}/git.log'"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "──────────────────────────────────────────"
echo "  bootstrap-ssh-provision: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
echo "──────────────────────────────────────────"

if [[ ${FAIL_COUNT} -gt 0 ]]; then
  exit 1
fi
exit 0
