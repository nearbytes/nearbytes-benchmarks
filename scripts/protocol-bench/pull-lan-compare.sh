#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
META="$ROOT/.local/tmp/lan_compare_run.meta"
[[ -f "$META" ]] || { echo "no $META — run bench:protocol:lan-compare:detached first" >&2; exit 1; }
REMOTE_OUT="$(grep '^remote_out=' "$META" | cut -d= -f2-)"
LOCAL_OUT="$(grep '^local_out=' "$META" | cut -d= -f2-)"
ALICE="$(node "$ROOT/scripts/lib/print-host-field.mjs" lan alice ssh)"
mkdir -p "$(dirname "$ROOT/$LOCAL_OUT")"
scp -q "$ALICE:$REMOTE_OUT" "$ROOT/$LOCAL_OUT"
cp "$ROOT/$LOCAL_OUT" "$ROOT/.local/bench/protocol/lan-compare.json"
echo "$ROOT/$LOCAL_OUT"
cat "$ROOT/$LOCAL_OUT"
