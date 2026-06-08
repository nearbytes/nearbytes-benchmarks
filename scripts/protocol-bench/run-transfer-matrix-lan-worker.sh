#!/usr/bin/env bash
# Worker: retry LAN transfer matrix until success (invoked detached).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?out json path}"
LOG="${2:?log path}"
META="${3:?meta path}"
cd "$ROOT"

attempt=0
while true; do
  attempt=$((attempt + 1))
  {
    echo "attempt=${attempt}"
    echo "last_attempt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >> "$META"
  echo "[worker $(date -u +%Y-%m-%dT%H:%M:%SZ)] attempt ${attempt}" >> "$LOG"
  pkill -f 'dist/scripts/protocol-peer.js' 2>/dev/null || true
  if env NEARBYTES_PROTOCOL_PEER_STDERR=1 \
    yarn bench:protocol:transfer-matrix -- --categories lan --skip-deploy --out "$OUT" >> "$LOG" 2>&1; then
    {
      echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "status=complete"
      echo "exit=0"
    } >> "$META"
    exit 0
  fi
  ec=$?
  echo "[worker $(date -u +%Y-%m-%dT%H:%M:%SZ)] failed exit=${ec}, retry in 120s" >> "$LOG"
  echo "last_exit=${ec}" >> "$META"
  sleep 120
done
