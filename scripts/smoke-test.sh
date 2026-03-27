#!/usr/bin/env bash

set -euo pipefail

# Smoke test for the running Jira proxy.
# Requires: Redis running, proxy running, JIRA_HMAC_SECRET set (or pulled from 1Password).

PROXY_URL="${PROXY_URL:-http://127.0.0.1:8793}"
HMAC_SECRET="${JIRA_HMAC_SECRET:-}"

# Try 1Password if no secret provided
if [[ -z "$HMAC_SECRET" ]]; then
  OP_TOKEN=$(security find-generic-password -s "openclaw.op_token_patch" -a "openclaw" -w 2>/dev/null || true)
  if [[ -n "$OP_TOKEN" ]]; then
    HMAC_SECRET=$(OP_SERVICE_ACCOUNT_TOKEN="$OP_TOKEN" op item get 6ah67ebyd45nx2xcwd44ujr6i4 --vault Patch --fields credential --reveal 2>/dev/null || true)
  fi
fi

if [[ -z "$HMAC_SECRET" ]]; then
  echo "FAIL: JIRA_HMAC_SECRET not set and could not pull from 1Password"
  exit 1
fi

PASS=0
FAIL=0

check() {
  local name="$1"
  local result="$2"
  local expected="$3"

  if [[ "$result" == "$expected" ]]; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name (got: $result, expected: $expected)"
    FAIL=$((FAIL + 1))
  fi
}

echo "Smoke test: $PROXY_URL"
echo ""

# 1. Redis
echo "[1/4] Redis"
REDIS_RESULT=$(redis-cli ping 2>/dev/null || echo "FAIL")
check "redis-cli ping" "$REDIS_RESULT" "PONG"

# 2. Health endpoint
echo "[2/4] Health"
HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$PROXY_URL/api/health" 2>/dev/null || echo "000")
check "GET /api/health" "$HEALTH_CODE" "200"

# 3. Webhook accepts valid HMAC
echo "[3/4] Webhook (valid HMAC)"
PAYLOAD='{"issue":{"key":"SMOKE-TEST","fields":{"summary":"smoke test","status":{"name":"test"}}},"changelog":{"items":[]}}'
SIG=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$HMAC_SECRET" | awk '{print $2}')
WEBHOOK_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 \
  -X POST "$PROXY_URL/" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature: sha256=$SIG" \
  -d "$PAYLOAD" 2>/dev/null || echo "000")
check "POST / (valid HMAC)" "$WEBHOOK_CODE" "202"

# 4. Webhook rejects bad HMAC
echo "[4/4] Webhook (invalid HMAC)"
BAD_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
  -X POST "$PROXY_URL/" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature: sha256=0000000000000000000000000000000000000000000000000000000000000000" \
  -d "$PAYLOAD" 2>/dev/null || echo "000")
check "POST / (bad HMAC)" "$BAD_CODE" "401"

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
