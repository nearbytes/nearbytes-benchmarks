#!/usr/bin/env bash
# Fast local bidirectional sync (replaces ad-hoc /tmp/nb-bidir loops).
# Uses friend handshake + 12s wall clock — will not hang for minutes.
#
#   bash scripts/run-bidirectional-local.sh
#   yarn e2e:bidirectional:local   # preferred (same flow via e2e harness)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BASE="${NEARBYTES_TEST_BASE:-$ROOT/.local/bench/bidirectional/manual-$(date +%s)}"
mkdir -p "$BASE"

export NEARBYTES_TEST_BASE="$BASE"
export NEARBYTES_TEST_PAYLOAD_BYTES="${NEARBYTES_TEST_PAYLOAD_BYTES:-1048576}"
export NEARBYTES_TEST_WARMUP_MS=200
export NEARBYTES_TEST_PEER_WAIT_MS=8000
export NEARBYTES_TEST_TIMEOUT_MS=8000
export NEARBYTES_TEST_POLL_MS=50
export NEARBYTES_TEST_GRACE_MS=300

WALL=12
TEST_JS="$ROOT/dist/scripts/sync-bidirectional-test.js"

if [[ ! -f "$TEST_JS" ]]; then
  yarn build
fi

echo "═══ bidirectional manual run ($BASE) — wall ${WALL}s ═══"

# Bob first, Alice after 250ms (both must be up for friend handshake)
NEARBYTES_TEST_ROLE=bob NEARBYTES_TEST_OUT="$BASE/bob/bidirectional-result.json" \
  node "$TEST_JS" >"$BASE/bob.log" 2>&1 &
BOB_PID=$!

sleep 0.25

NEARBYTES_TEST_ROLE=alice NEARBYTES_TEST_OUT="$BASE/alice/bidirectional-result.json" \
  node "$TEST_JS" >"$BASE/alice.log" 2>&1 &
ALICE_PID=$!

(
  sleep "$WALL"
  kill "$BOB_PID" "$ALICE_PID" 2>/dev/null || true
) &
WATCHER=$!

wait "$ALICE_PID" 2>/dev/null; A=$?
wait "$BOB_PID" 2>/dev/null; B=$?
kill "$WATCHER" 2>/dev/null || true

echo "exit alice=$A bob=$B"
echo "=== alice ==="; tail -15 "$BASE/alice.log" || true
echo "=== bob ==="; tail -15 "$BASE/bob.log" || true

ok() { [[ "$1" -eq 0 || "$1" -eq 143 ]] && return 0; return 1; }
if ! ok "$A" || ! ok "$B"; then
  exit 1
fi

node scripts/merge-bidirectional-report.mjs \
  --alice "$BASE/alice/bidirectional-result.json" \
  --bob "$BASE/bob/bidirectional-result.json" \
  --out "$BASE/sync-report.json" \
  --topology "localhost (two processes, 1 MiB each way)"

echo "Report: $BASE/sync-report.json"
