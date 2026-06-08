#!/usr/bin/env bash
# Runs ON the LAN alice host (pc-ciancia). Orchestrates alice locally + bob over lab LAN.
# No SSH back to the Mac — survives VPN disconnect on the control machine.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?out json path (absolute or relative to repo)}"
LOG="${2:?log path}"
META="${3:?meta path}"
cd "$ROOT"

WORKDIR="$(cd "$ROOT/.." && pwd)"
NODE_BIN="${WORKDIR}/.toolchain/node-v22.18.0-linux-x64/bin/node"
MATRIX="${ROOT}/scripts/protocol-bench/run-transfer-matrix.mjs"
TARGET_MS="${NEARBYTES_TRANSFER_TARGET_MS:-30000}"
RETRY_SEC="${NEARBYTES_LAN_REMOTE_RETRY_SEC:-90}"

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node)"
fi

attempt=0
while true; do
  attempt=$((attempt + 1))
  {
    echo "attempt=${attempt}"
    echo "last_attempt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "status=running"
  } > "$META"
  echo "[remote-worker $(date -u +%Y-%m-%dT%H:%M:%SZ)] attempt ${attempt} targetMs=${TARGET_MS}" >> "$LOG"
  pkill -f '[p]rotocol-peer.js' 2>/dev/null || true
  if env NEARBYTES_PROTOCOL_PEER_STDERR=1 NEARBYTES_LAN_ALICE_ON_HOST=1 \
    "$NODE_BIN" "$MATRIX" -- --categories lan --lan-alice-on-host --skip-deploy --target-ms "$TARGET_MS" --out "$OUT" >> "$LOG" 2>&1; then
    {
      echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "status=complete"
      echo "exit=0"
    } >> "$META"
    exit 0
  else
    ec=$?
    echo "[remote-worker $(date -u +%Y-%m-%dT%H:%M:%SZ)] failed exit=${ec}, retry in ${RETRY_SEC}s" >> "$LOG"
    {
      echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "last_exit=${ec}"
      echo "status=failed"
    } >> "$META"
    sleep "$RETRY_SEC"
  fi
done
