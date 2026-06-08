#!/usr/bin/env bash
# Runs ON the LAN alice host (pc-ciancia). Orchestrates alice locally + bob over lab LAN.
# No SSH back to the Mac — survives VPN disconnect on the control machine.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?out json path (absolute or relative to repo)}"
LOG="${2:?log path}"
META="${3:?meta path}"
cd "$ROOT"

WORKDIR="$(cd "$ROOT/.." && pwd)"
NODE_BIN="${WORKDIR}/.toolchain/node-v22.18.0-linux-x64/bin/node"
MATRIX="${ROOT}/scripts/protocol-bench/run-transfer-matrix.mjs"

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node)"
fi

{
  echo "attempt=1"
  echo "last_attempt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "status=running"
} > "$META"
echo "[remote-worker $(date -u +%Y-%m-%dT%H:%M:%SZ)] starting (single attempt, fail-fast timeouts)" >> "$LOG"
pkill -f '[p]rotocol-peer.js' 2>/dev/null || true
if env NEARBYTES_PROTOCOL_PEER_STDERR=1 NEARBYTES_LAN_ALICE_ON_HOST=1 \
  "$NODE_BIN" "$MATRIX" -- --categories lan --lan-alice-on-host --skip-deploy --target-ms "${NEARBYTES_TRANSFER_TARGET_MS:-30000}" --out "$OUT" >> "$LOG" 2>&1; then
  {
    echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "status=complete"
    echo "exit=0"
  } >> "$META"
  exit 0
fi
ec=$?
echo "[remote-worker $(date -u +%Y-%m-%dT%H:%M:%SZ)] failed exit=${ec}" >> "$LOG"
{
  echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "status=failed"
  echo "exit=${ec}"
} >> "$META"
exit "$ec"
