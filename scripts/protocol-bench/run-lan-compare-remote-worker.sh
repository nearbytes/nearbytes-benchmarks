#!/usr/bin/env bash
# Runs ON pc-ciancia.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?out json}"
LOG="${2:?log}"
META="${3:?meta}"
cd "$ROOT"

WORKDIR="$(cd "$ROOT/.." && pwd)"
NODE_BIN="${WORKDIR}/.toolchain/node-v22.18.0-linux-x64/bin/node"
COMPARE="${ROOT}/scripts/protocol-bench/run-lan-compare.mjs"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node)"

{
  echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "status=running"
} > "$META"

if env NEARBYTES_LAN_ALICE_ON_HOST=1 NEARBYTES_PROTOCOL_PEER_STDERR=1 \
  "$NODE_BIN" "$COMPARE" -- --lan-alice-on-host --skip-deploy --limit-ms "${NEARBYTES_LAN_COMPARE_LIMIT_MS:-30000}" --out "$OUT" >> "$LOG" 2>&1; then
  echo "status=complete" >> "$META"
  echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$META"
  exit 0
fi

echo "status=failed" >> "$META"
echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$META"
exit 1
