#!/usr/bin/env bash
# Wait for LAN transfer matrix, pull results if remote, then refresh paper figures.
set -euo pipefail
BENCH="$(cd "$(dirname "$0")/.." && pwd)"
PAPER="$(cd "$BENCH/../../NEARBYTES-PAPERS/paper-nearbytes-hypercore" && pwd)"
META="$BENCH/.local/tmp/transfer_lan_run.meta"
PIDFILE="$BENCH/.local/tmp/transfer_lan.pid"

cd "$BENCH"

if [[ -f "$BENCH/.local/bench/protocol/transfer-matrix-lan-full.json" ]]; then
  echo "Using local transfer-matrix-lan-full.json (skip remote pull)"
elif [[ -f "$META" ]] && grep -q '^mode=remote' "$META" 2>/dev/null; then
  echo "Remote LAN run — polling alice for completion…"
  bash "$BENCH/scripts/protocol-bench/wait-transfer-matrix-lan-remote.sh" || {
    echo "Remote LAN run not complete — see remote log on orchestrator" >&2
    exit 1
  }
  bash "$BENCH/scripts/protocol-bench/pull-transfer-matrix-lan.sh"
else
  if [[ -f "$PIDFILE" ]]; then
    pid="$(cat "$PIDFILE")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "Waiting for LAN transfer matrix (pid=$pid)…"
      while kill -0 "$pid" 2>/dev/null; do sleep 30; done
    fi
  fi
  if [[ -f "$META" ]] && grep -q '^status=failed' "$META" 2>/dev/null; then
    echo "LAN run failed — see $BENCH/.local/tmp/transfer_lan_latest.log"
    exit 1
  fi
fi

cd "$PAPER"
yarn paper:update --source "$BENCH/.local/bench"
