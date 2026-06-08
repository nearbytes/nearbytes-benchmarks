#!/usr/bin/env bash
# Run LAN transfer matrix on remote alice (pc-ciancia) — survives Mac VPN disconnect.
#
# Progress (remote):  ssh pc-ciancia 'tail -f ~/nearbytes-bench/nearbytes-benchmarks/.local/tmp/transfer_lan_remote.log'
# Meta (local):       cat .local/tmp/transfer_lan_run.meta
# Pull + paper:       yarn bench:protocol:transfer-matrix:lan:finish-paper
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LAUNCH="$ROOT/scripts/protocol-bench/run-transfer-matrix-lan-remote-launch.sh"
PIDFILE="$ROOT/.local/tmp/transfer_lan.pid"

cd "$ROOT"
mkdir -p .local/tmp .local/bench/protocol
chmod +x "$LAUNCH" "$ROOT/scripts/protocol-bench/"*.sh 2>/dev/null || true

pkill -f 'run-transfer-matrix-lan-worker' 2>/dev/null || true
pkill -f 'run-transfer-matrix.mjs.*--categories lan' 2>/dev/null || true

if [[ -f "$PIDFILE" ]]; then
  rm -f "$PIDFILE"
fi

exec "$LAUNCH"
