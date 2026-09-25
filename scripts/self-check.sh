#!/usr/bin/env bash
# Eligibility gate self-check — mirrors the Scaffold-HBAR Template Bounty's stage-one checklist.
# The official self-check script (promised "the week before the build window opens") wasn't
# published as of this run, so this stands in for it. Re-run against the real one once it lands.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0

check() {
  local desc="$1"
  shift
  if "$@" > /tmp/self-check-output.log 2>&1; then
    echo "PASS  $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $desc"
    sed 's/^/      /' /tmp/self-check-output.log | tail -10
    FAIL=$((FAIL + 1))
  fi
}

echo "== Eligibility gate self-check =="
echo

check "template.json present and valid JSON" bash -c "python3 -c \"import json; json.load(open('template.json'))\""
check "README.md present" test -f README.md
check "AGENTS.md present" test -f AGENTS.md
check "LICENSE present and MIT" grep -q "MIT License" LICENSE
check "package.json declares MIT license" bash -c "python3 -c \"import json; assert json.load(open('package.json'))['license']=='MIT'\""
check "No .env committed to git" bash -c "! git ls-files | grep -qE '(^|/)\\.env$'"
check "No secret-looking values in tracked files" bash -c "! git grep -InE '(OPERATOR_KEY|PRIVATE_KEY)\\s*=\\s*0x[0-9a-fA-F]{32,}' -- ':!*.md' ':!scripts/self-check.sh'"
check "Install passes clean" npm install
check "Contracts + frontend build passes clean" npm run build
check "Contracts lint config resolves" npm run lint --workspace packages/contracts
check "Contract test suite passes" npm run test --workspace packages/contracts
check "At least one verifiable testnet transaction documented in README" grep -q "hashscan.io/testnet/transaction" README.md
check "Harness spec present (harness was used)" test -f .harness/spec.yaml
check "Harness validators present" bash -c "test -f .harness/validators/static.json && test -f .harness/validators/npm.json"

echo
echo "== App boot check =="
(npm run dev --workspace packages/frontend > /tmp/self-check-dev.log 2>&1 &)
DEV_PID_SEARCH_ATTEMPTS=15
BOOTED=0
for i in $(seq 1 $DEV_PID_SEARCH_ATTEMPTS); do
  sleep 2
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health 2>/dev/null | grep -q "200"; then
    BOOTED=1
    break
  fi
done

if [ "$BOOTED" -eq 1 ]; then
  echo "PASS  App boots, /api/health returns 200"
  PASS=$((PASS + 1))
  if curl -s http://localhost:3000/ | grep -q "hedera-safe-swap"; then
    echo "PASS  Core route / returns OK"
    PASS=$((PASS + 1))
  else
    echo "FAIL  Core route / did not return expected content"
    FAIL=$((FAIL + 1))
  fi
else
  echo "FAIL  App did not boot within $((DEV_PID_SEARCH_ATTEMPTS * 2))s"
  FAIL=$((FAIL + 1))
fi

pkill -f "next dev" > /dev/null 2>&1 || true
lsof -ti:3000 2>/dev/null | xargs -r kill -9 2>/dev/null || true

echo
echo "== Result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
