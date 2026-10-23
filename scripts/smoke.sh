#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${BASE:-http://127.0.0.1:3999}"
for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health" || true)
    if [ "$code" = "200" ]; then
        echo "server ready"
        break
    fi
    sleep 0.5
done
curl -s "$BASE/health"
echo
BASE="$BASE" TMP_DIR="${BASE_TMP:-}" node "$ROOT/scripts/smoke.mjs"
status=$?
echo "smoke exit: $status"
exit $status
