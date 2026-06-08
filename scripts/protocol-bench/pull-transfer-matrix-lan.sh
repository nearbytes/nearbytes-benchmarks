#!/usr/bin/env bash
# Pull completed LAN transfer-matrix JSON from the remote alice orchestrator.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
META="$ROOT/.local/tmp/transfer_lan_run.meta"

if [[ ! -f "$META" ]]; then
  echo "No LAN run meta at $META" >&2
  exit 1
fi

ORCHESTRATOR="$(grep '^orchestrator=' "$META" | tail -1 | cut -d= -f2-)"
REMOTE_OUT="$(grep '^remote_out=' "$META" | tail -1 | cut -d= -f2-)"
LOCAL_OUT="$(grep '^local_out=' "$META" | tail -1 | cut -d= -f2-)"
REMOTE_META="$(grep '^remote_meta=' "$META" | tail -1 | cut -d= -f2-)"

if [[ -z "$ORCHESTRATOR" || -z "$REMOTE_OUT" || -z "$LOCAL_OUT" ]]; then
  echo "Meta missing remote fields — is this a remote LAN run?" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOCAL_OUT")"

if ssh -o ConnectTimeout=20 "$ORCHESTRATOR" "test -f '$REMOTE_OUT'"; then
  scp -q "$ORCHESTRATOR:$REMOTE_OUT" "$LOCAL_OUT"
  echo "Pulled $LOCAL_OUT"
else
  echo "Remote result not ready: $REMOTE_OUT" >&2
  exit 1
fi

if ssh -o ConnectTimeout=20 "$ORCHESTRATOR" "test -f '$REMOTE_META'"; then
  echo "--- remote meta ---"
  ssh -o ConnectTimeout=20 "$ORCHESTRATOR" "cat '$REMOTE_META'"
fi

status="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LOCAL_OUT','utf8')).status)")"
if [[ "$status" == "complete" ]]; then
  grep -v '^status=' "$META" > "${META}.tmp" || true
  mv "${META}.tmp" "$META"
  cat "$META"
  echo "status=complete" >> "$META"
fi

echo "$LOCAL_OUT"
