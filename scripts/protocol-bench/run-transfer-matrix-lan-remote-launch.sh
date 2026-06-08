#!/usr/bin/env bash
# Mac-side launcher: one short SSH to start the LAN matrix ON pc-ciancia (alice).
# The benchmark runs entirely on lab hosts; Mac only syncs scripts + polls for results.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

HOSTS_JSON="$(node "$ROOT/scripts/lib/resolve-config-path.mjs")"
ALICE="$(node "$ROOT/scripts/lib/print-host-field.mjs" lan alice ssh)"
ALICE_WORKDIR="$(node "$ROOT/scripts/lib/print-host-field.mjs" lan alice workdir)"
BOB="$(node "$ROOT/scripts/lib/print-host-field.mjs" lan bob ssh)"
NB="$ALICE_WORKDIR/nearbytes-benchmarks"

STAMP="$(date +%Y%m%d-%H%M%S)"
REMOTE_OUT="$NB/.local/bench/protocol/transfer-matrix-lan-${STAMP}.json"
LOCAL_OUT=".local/bench/protocol/transfer-matrix-lan-${STAMP}.json"
REMOTE_LOG="$NB/.local/tmp/transfer_lan_remote.log"
REMOTE_META="$NB/.local/tmp/transfer_lan_remote.meta"
REMOTE_PIDFILE="$NB/.local/tmp/transfer_lan_remote.pid"
LOG=".local/tmp/transfer_lan_latest.log"
META=".local/tmp/transfer_lan_run.meta"
PIDFILE=".local/tmp/transfer_lan.pid"

mkdir -p .local/tmp .local/bench/protocol

echo "LAN remote launch: alice=${ALICE} bob=${BOB}"
echo "Preflight SSH to alice (short)…"
ssh -o ConnectTimeout=15 -o BatchMode=yes "$ALICE" 'echo alice-ok' >/dev/null

echo "Syncing harness scripts to ${ALICE}…"
rsync -az \
  --exclude='node_modules' --exclude='dist' --exclude='.git' \
  "$ROOT/scripts/protocol-bench/" "$ALICE:$NB/scripts/protocol-bench/"
rsync -az \
  "$ROOT/scripts/network-bench/lib/" "$ALICE:$NB/scripts/network-bench/lib/"
rsync -az \
  "$ROOT/scripts/lib/" "$ALICE:$NB/scripts/lib/"
scp -q "$HOSTS_JSON" "$ALICE:$NB/config/local.json"

echo "Ensuring alice can SSH to bob (cross-host)…"
if ! ssh -o ConnectTimeout=15 -o BatchMode=yes -n "$ALICE" "ssh -o BatchMode=yes -o ConnectTimeout=10 $BOB 'echo bob-from-alice-ok'" >/dev/null 2>&1; then
  echo "Cross-host SSH failed — seeding alice ~/.ssh/config and authorized_keys on bob…"
  ssh -o ConnectTimeout=15 -n "$ALICE" 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/config && chmod 600 ~/.ssh/config && grep -q "Host fmt-5000" ~/.ssh/config 2>/dev/null || printf "%s\n" "Host fmt-5000" "    HostName fmt-5000.isti.cnr.it" "    User vincenzo" "    Port 10122" "    StrictHostKeyChecking accept-new" >> ~/.ssh/config'
  TMPKEY="$(mktemp)"
  ssh -o ConnectTimeout=15 -n "$ALICE" 'cat ~/.ssh/id_rsa.pub' > "$TMPKEY"
  scp -q -o ConnectTimeout=15 "$TMPKEY" "$BOB:/tmp/alice_from_ciancia.pub"
  ssh -o ConnectTimeout=15 -n "$BOB" 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qF "$(cat /tmp/alice_from_ciancia.pub)" ~/.ssh/authorized_keys 2>/dev/null || cat /tmp/alice_from_ciancia.pub >> ~/.ssh/authorized_keys; rm -f /tmp/alice_from_ciancia.pub'
  rm -f "$TMPKEY"
  ssh -o ConnectTimeout=15 -o BatchMode=yes -n "$ALICE" "ssh -o BatchMode=yes -o ConnectTimeout=10 $BOB 'echo bob-from-alice-ok'" >/dev/null
fi

echo "Stopping any prior remote worker…"
ssh -n "$ALICE" "pkill -f '[r]un-transfer-matrix-lan-remote-worker' 2>/dev/null || true; pkill -f '[p]rotocol-peer.js' 2>/dev/null || true"

ssh -n "$ALICE" "mkdir -p '$NB/.local/bench/protocol' '$NB/.local/tmp' && chmod +x '$NB/scripts/protocol-bench/run-transfer-matrix-lan-remote-worker.sh'"

{
  echo "mode=remote"
  echo "stamp=${STAMP}"
  echo "orchestrator=${ALICE}"
  echo "bob=${BOB}"
  echo "remote_out=${REMOTE_OUT}"
  echo "local_out=${LOCAL_OUT}"
  echo "remote_log=${REMOTE_LOG}"
  echo "remote_meta=${REMOTE_META}"
  echo "log=${LOG}"
  echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "status=running"
} > "$META"
: > "$LOG"
echo "[launch $(date -u +%Y-%m-%dT%H:%M:%SZ)] remote worker starting on ${ALICE}" >> "$LOG"

ssh -n "$ALICE" "cd '$NB' && nohup '$NB/scripts/protocol-bench/run-transfer-matrix-lan-remote-worker.sh' '$REMOTE_OUT' '$REMOTE_LOG' '$REMOTE_META' >> '$REMOTE_LOG' 2>&1 & echo \$! > '$REMOTE_PIDFILE'"

echo "Remote LAN transfer matrix started on ${ALICE}"
echo "  remote out: ${REMOTE_OUT}"
echo "  remote log: ${REMOTE_LOG}"
echo "  pull when done: yarn bench:lan:pull"
cat "$META"
