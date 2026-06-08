#!/usr/bin/env bash
# Launch minimal LAN compare on pc-ciancia (≤60s per system). Mac can disconnect after launch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

HOSTS_JSON="$(node "$ROOT/scripts/lib/resolve-config-path.mjs")"
ALICE="$(node "$ROOT/scripts/lib/print-host-field.mjs" lan alice ssh)"
ALICE_WORKDIR="$(node "$ROOT/scripts/lib/print-host-field.mjs" lan alice workdir)"
BOB="$(node "$ROOT/scripts/lib/print-host-field.mjs" lan bob ssh)"
NB="$ALICE_WORKDIR/nearbytes-benchmarks"

STAMP="$(date +%Y%m%d-%H%M%S)"
REMOTE_OUT="$NB/.local/bench/protocol/lan-compare-${STAMP}.json"
REMOTE_LOG="$NB/.local/tmp/lan_compare_remote.log"
REMOTE_META="$NB/.local/tmp/lan_compare_remote.meta"
LOCAL_OUT=".local/bench/protocol/lan-compare-${STAMP}.json"
LOCAL_META=".local/tmp/lan_compare_run.meta"

mkdir -p .local/tmp .local/bench/protocol

echo "LAN compare detached: alice=${ALICE} bob=${BOB}"
ssh -o ConnectTimeout=15 -o BatchMode=yes "$ALICE" 'echo alice-ok' >/dev/null

echo "Deploy latest bits to CNR hosts…"
node --input-type=module -e "
import { ensureRemoteWorkspace } from './scripts/network-bench/lib/deploy.mjs';
await Promise.all([
  ensureRemoteWorkspace('$ALICE', '$ALICE_WORKDIR'),
  ensureRemoteWorkspace('$BOB', '/home/vincenzo/nearbytes-bench'),
]);
console.log('deploy ok');
"

rsync -az \
  --exclude='node_modules' --exclude='.git' \
  "$ROOT/scripts/protocol-bench/" "$ALICE:$NB/scripts/protocol-bench/"
rsync -az \
  "$ROOT/scripts/network-bench/lib/" "$ALICE:$NB/scripts/network-bench/lib/"
rsync -az \
  "$ROOT/scripts/lib/" "$ALICE:$NB/scripts/lib/"
scp -q "$HOSTS_JSON" "$ALICE:$NB/config/local.json"

echo "Ensure alice→bob SSH for baselines…"
if ! ssh -o ConnectTimeout=15 -o BatchMode=yes -n "$ALICE" "ssh -o BatchMode=yes -o ConnectTimeout=10 $BOB 'echo ok'" >/dev/null 2>&1; then
  ssh -n "$ALICE" 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/config && chmod 600 ~/.ssh/config && grep -q "Host fmt-5000" ~/.ssh/config 2>/dev/null || printf "%s\n" "Host fmt-5000" "    HostName fmt-5000.isti.cnr.it" "    User vincenzo" "    Port 10122" "    StrictHostKeyChecking accept-new" >> ~/.ssh/config'
  TMPKEY="$(mktemp)"
  ssh -n "$ALICE" 'cat ~/.ssh/id_rsa.pub' > "$TMPKEY"
  scp -q "$TMPKEY" "$BOB:/tmp/alice_from_ciancia.pub"
  ssh -n "$BOB" 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qF "$(cat /tmp/alice_from_ciancia.pub)" ~/.ssh/authorized_keys 2>/dev/null || cat /tmp/alice_from_ciancia.pub >> ~/.ssh/authorized_keys; rm -f /tmp/alice_from_ciancia.pub'
  rm -f "$TMPKEY"
fi

ssh -n "$ALICE" "pkill -f '[r]un-lan-compare' 2>/dev/null || true; pkill -f '[p]rotocol-peer.js' 2>/dev/null || true"
ssh -n "$ALICE" "mkdir -p '$NB/.local/bench/protocol' '$NB/.local/tmp' && chmod +x '$NB/scripts/protocol-bench/run-lan-compare-remote-worker.sh'"

{
  echo "mode=lan-compare-detached"
  echo "stamp=${STAMP}"
  echo "remote_out=${REMOTE_OUT}"
  echo "local_out=${LOCAL_OUT}"
  echo "remote_log=${REMOTE_LOG}"
  echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "status=running"
} > "$LOCAL_META"

WORKER="$NB/scripts/protocol-bench/run-lan-compare-remote-worker.sh"
ssh -n "$ALICE" "cd '$NB' && nohup '$WORKER' '$REMOTE_OUT' '$REMOTE_LOG' '$REMOTE_META' >> '$REMOTE_LOG' 2>&1 & echo \$! > '$NB/.local/tmp/lan_compare_remote.pid'"

echo "Started on ${ALICE}"
echo "  log: ssh ${ALICE} tail -f ${REMOTE_LOG}"
echo "  pull: scp ${ALICE}:${REMOTE_OUT} ${LOCAL_OUT}"
cat "$LOCAL_META"
