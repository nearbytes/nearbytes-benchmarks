#!/usr/bin/env bash
# Poll remote alice until LAN transfer matrix completes (brief SSH probes only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
META="$ROOT/.local/tmp/transfer_lan_run.meta"
INTERVAL="${NEARBYTES_LAN_POLL_SEC:-30}"
MAX_SEC="${NEARBYTES_LAN_WAIT_MAX_SEC:-0}"
START_TS="$(date +%s)"

if [[ ! -f "$META" ]]; then
  echo "No LAN run meta at $META" >&2
  exit 1
fi

ORCHESTRATOR="$(grep '^orchestrator=' "$META" | tail -1 | cut -d= -f2-)"
REMOTE_META="$(grep '^remote_meta=' "$META" | tail -1 | cut -d= -f2-)"
REMOTE_LOG="$(grep '^remote_log=' "$META" | tail -1 | cut -d= -f2-)"

echo "Waiting for remote LAN matrix on ${ORCHESTRATOR} (poll every ${INTERVAL}s)…"
while true; do
  if remote_status="$(ssh -o ConnectTimeout=20 -o BatchMode=yes "$ORCHESTRATOR" "grep '^status=' '$REMOTE_META' 2>/dev/null | tail -1" 2>/dev/null)"; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $remote_status"
    if [[ "$remote_status" == "status=complete" ]]; then
      echo "status=complete" >> "$META"
      exit 0
    fi
    if [[ "$remote_status" == "status=failed" ]]; then
      echo "remote LAN matrix failed — see ${REMOTE_LOG} on ${ORCHESTRATOR}" >&2
      exit 1
    fi
  else
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] SSH probe failed — VPN may be down; will retry"
  fi
  if [[ "$MAX_SEC" -gt 0 ]] && [[ "$(($(date +%s) - START_TS))" -ge "$MAX_SEC" ]]; then
    echo "LAN wait exceeded ${MAX_SEC}s" >&2
    exit 1
  fi
  sleep "$INTERVAL"
done
