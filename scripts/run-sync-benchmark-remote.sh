#!/usr/bin/env bash
# Research benchmark: receiver on pc-ciancia, sender on this Mac.
# Line-buffered output + heartbeats on every long wait (never looks stuck).
set -euo pipefail

if [[ -z "${BENCH_NO_REEXEC:-}" ]] && command -v stdbuf >/dev/null 2>&1; then
  export BENCH_NO_REEXEC=1
  exec stdbuf -oL -eL bash "$0" "$@"
fi

export NODE_NO_WARNINGS=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
_eval_cfg() {
  node --input-type=module -e "
import { getRemoteHost, getBenchPaths } from './tests/e2e/lib/config.mjs';
const [host, p] = await Promise.all([getRemoteHost(), getBenchPaths()]);
console.log([host, p.benchBaseLocal, p.benchBaseRemote, p.benchReportsDir, p.sshConnectTimeoutSec].join('\t'));
" 2>/dev/null || printf '%s\t%s\t%s\t%s\t10\n' "pc-ciancia" "${ROOT}/.local/bench/work" "/tmp/nearbytes-sync-benchmark" "${ROOT}/.local/bench/reports"
}
IFS=$'\t' read -r _CFG_HOST _CFG_BENCH_LOCAL _CFG_BENCH_REMOTE _CFG_REPORTS _CFG_SSH_TO <<< "$(_eval_cfg)"
REMOTE_HOST="${NEARBYTES_REMOTE_HOST:-$_CFG_HOST}"
REPOS_BASE="${NEARBYTES_REPOS:-https://github.com/nearbytes}"
BENCH_BASE_LOCAL="${NEARBYTES_BENCH_BASE:-$_CFG_BENCH_LOCAL}"
BENCH_BASE_REMOTE="${NEARBYTES_BENCH_BASE_REMOTE:-$_CFG_BENCH_REMOTE}"
OUT_DIR="${NEARBYTES_BENCH_OUTDIR:-$_CFG_REPORTS/remote-latest}"
SSH_OPTS=(-o BatchMode=yes -o "ConnectTimeout=${NEARBYTES_SSH_CONNECT_TIMEOUT:-$_CFG_SSH_TO}")
if [[ "${NEARBYTES_BENCH_PROFILE:-}" == "latency-only" ]]; then
  export NEARBYTES_BENCH_PROFILE=latency-only
  export NEARBYTES_BENCH_DISCOVERY_MS="${NEARBYTES_BENCH_DISCOVERY_MS:-2000}"
  export NEARBYTES_BENCH_GRACE_MS="${NEARBYTES_BENCH_GRACE_MS:-1500}"
  export NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS="${NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS:-25000}"
  BENCH_RECV_DEADLINE_SEC="${BENCH_RECV_DEADLINE_SEC:-45}"
  BENCH_COUNTDOWN_SEC="${BENCH_COUNTDOWN_SEC:-2}"
  BENCH_POLL_SEC="${BENCH_POLL_SEC:-1}"
elif [[ "${NEARBYTES_BENCH_QUICK:-}" == "1" || "${NEARBYTES_BENCH_QUICK:-}" == "true" ]]; then
  export NEARBYTES_BENCH_QUICK=1
  BENCH_RECV_DEADLINE_SEC="${BENCH_RECV_DEADLINE_SEC:-50}"
  BENCH_COUNTDOWN_SEC="${BENCH_COUNTDOWN_SEC:-3}"
  BENCH_POLL_SEC="${BENCH_POLL_SEC:-5}"
else
  BENCH_RECV_DEADLINE_SEC="${BENCH_RECV_DEADLINE_SEC:-600}"
  BENCH_COUNTDOWN_SEC="${BENCH_COUNTDOWN_SEC:-12}"
  BENCH_POLL_SEC="${BENCH_POLL_SEC:-5}"
fi
TOTAL_STEPS=7
STEP=0
RUN_START=$SECONDS

progress() {
  STEP=$((STEP + 1))
  local elapsed=$((SECONDS - RUN_START))
  printf '\n[%02d:%02d] ═══ STEP %d/%d: %s ═══\n' "$((elapsed / 60))" "$((elapsed % 60))" "$STEP" "$TOTAL_STEPS" "$1"
}

heartbeat() {
  local elapsed=$((SECONDS - RUN_START))
  printf '[%02d:%02d] … %s\n' "$((elapsed / 60))" "$((elapsed % 60))" "$1"
}

countdown() {
  local secs=$1
  local label=$2
  local i
  for ((i = secs; i >= 1; i--)); do
    heartbeat "${label} — starting in ${i}s"
    sleep 1
  done
}

poll_remote_log() {
  local log_path=$1
  ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "tail -n 8 '${log_path}' 2>/dev/null || true" 2>/dev/null \
    | stream_lines '[remote]' || true
}

run_yarn() {
  if command -v yarn >/dev/null 2>&1; then yarn "$@"; else corepack prepare yarn@4.5.1 --activate && yarn "$@"; fi
}

stream_lines() {
  local prefix=$1
  while IFS= read -r line; do
    printf '%s %s\n' "$prefix" "$line"
  done
}

progress "Kill stray benchmark processes"
pkill -f 'node dist/sync-benchmark' 2>/dev/null || true
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" 'pkill -f sync-benchmark 2>/dev/null || true' 2>/dev/null || true

progress "Build sender (local nearbytes-files)"
cd "$ROOT"
if [[ "${NEARBYTES_BENCH_PROFILE:-}" == "latency-only" && -d node_modules ]]; then
  heartbeat "yarn build (local, skip install)"
  run_yarn build
else
  heartbeat "yarn install (local)"
  run_yarn install
  heartbeat "yarn build (local)"
  run_yarn build
fi

SYNC_LOCAL_DIST=0
if [[ "${NEARBYTES_BENCH_PROFILE:-}" == "latency-only" || "${NEARBYTES_BENCH_SYNC_LOCAL:-}" == "1" ]]; then
  SYNC_LOCAL_DIST=1
fi

SKIP_REMOTE_BUILD=0
if [[ "${NEARBYTES_BENCH_QUICK:-}" == "1" ]]; then
  if ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "test -f '${BENCH_BASE_REMOTE}/repos/nearbytes-benchmarks/dist/sync-benchmark.js'"; then
    SKIP_REMOTE_BUILD=1
    heartbeat "QUICK: skip remote build (dist already present)"
  fi
fi

if [[ "$SYNC_LOCAL_DIST" -eq 1 ]]; then
  progress "Build + rsync local dist to ${REMOTE_HOST} (same code as sender)"
  SYNC_ROOT="$(cd "$ROOT/.." && pwd)"
  heartbeat "build nearbytes-sync (local)"
  (cd "$SYNC_ROOT/nearbytes-sync" && npm run build)
  ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "mkdir -p '${BENCH_BASE_REMOTE}/repos/nearbytes-benchmarks' '${BENCH_BASE_REMOTE}/repos/nearbytes-files' '${BENCH_BASE_REMOTE}/repos/nearbytes-sync'"
  rsync -az --delete "$ROOT/dist/" "${REMOTE_HOST}:${BENCH_BASE_REMOTE}/repos/nearbytes-benchmarks/dist/"
  rsync -az --delete "$SYNC_ROOT/nearbytes-files/dist/" "${REMOTE_HOST}:${BENCH_BASE_REMOTE}/repos/nearbytes-files/dist/"
  rsync -az --delete "$SYNC_ROOT/nearbytes-sync/dist/" "${REMOTE_HOST}:${BENCH_BASE_REMOTE}/repos/nearbytes-sync/dist/"
  SKIP_REMOTE_BUILD=1
fi

if [[ "$SKIP_REMOTE_BUILD" -eq 0 ]]; then
progress "Pull + build receiver repos on ${REMOTE_HOST} (nearbytes-log must include 10df209)"
REMOTE_BUILD_SCRIPT="$(mktemp)"
trap 'rm -f "$REMOTE_BUILD_SCRIPT"' EXIT
cat > "$REMOTE_BUILD_SCRIPT" <<REMOTE
set -euo pipefail
REPOS_BASE="${REPOS_BASE}"
BENCH_BASE="${BENCH_BASE_REMOTE}"
run_yarn() {
  if command -v yarn >/dev/null 2>&1; then yarn "\$@"; else export COREPACK_HOME="\$BENCH_BASE/.corepack"; mkdir -p "\$COREPACK_HOME"; corepack prepare yarn@4.5.1 --activate; corepack yarn "\$@"; fi
}
build_repo() {
  local dir="\$1"
  echo "START \$(basename "\$dir")"
  cd "\$dir"
  if [[ -f yarn.lock ]]; then run_yarn install && run_yarn build; else npm install --no-fund --no-audit && npm run build; fi
  echo "DONE \$(basename "\$dir")"
}
mkdir -p "\$BENCH_BASE/repos"
cd "\$BENCH_BASE/repos"
for repo in nearbytes-crypto nearbytes-log nearbytes-sync nearbytes-skeleton nearbytes-files nearbytes-benchmarks; do
  if [[ ! -d "\$repo/.git" ]]; then
    echo "CLONE \$repo"
    git clone --depth 1 "\$REPOS_BASE/\${repo}.git" "\$repo"
  else
    echo "PULL \$repo"
    git -C "\$repo" pull --ff-only
  fi
done
LOG_HEAD=\$(git -C nearbytes-log log -1 --oneline)
echo "nearbytes-log at: \$LOG_HEAD"
case "\$LOG_HEAD" in
  *10df209*) echo "OK reception-journal fix present" ;;
  *) echo "WARN: expected 10df209 on nearbytes-log — benchmark may fail" ;;
esac
for repo in nearbytes-crypto nearbytes-log nearbytes-sync nearbytes-skeleton nearbytes-files nearbytes-benchmarks; do
  build_repo "\$BENCH_BASE/repos/\$repo"
done
echo "ALL_BUILDS_DONE"
REMOTE
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "bash -s" < "$REMOTE_BUILD_SCRIPT" 2>&1 | stream_lines '[remote-build]'
fi

REMOTE_LOG="${BENCH_BASE_REMOTE}/bob/bench-run.log"
REMOTE_RESULT="${BENCH_BASE_REMOTE}/bob/benchmark-result.json"

progress "Start receiver (bob) on ${REMOTE_HOST} (detached — no blocking SSH pipe)"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" bash -s <<REMOTE
set -euo pipefail
cd "${BENCH_BASE_REMOTE}/repos/nearbytes-benchmarks"
: > "${REMOTE_LOG}"
nohup env \
  NEARBYTES_BENCH_ROLE=receiver \
  NEARBYTES_BENCH_BASE="${BENCH_BASE_REMOTE}" \
  NEARBYTES_BENCH_OUT="${REMOTE_RESULT}" \
  NEARBYTES_BENCH_PROFILE="${NEARBYTES_BENCH_PROFILE:-}" \
  NEARBYTES_BENCH_QUICK="${NEARBYTES_BENCH_QUICK:-}" \
  NEARBYTES_BENCH_DISCOVERY_MS="${NEARBYTES_BENCH_DISCOVERY_MS:-}" \
  NEARBYTES_BENCH_GRACE_MS="${NEARBYTES_BENCH_GRACE_MS:-}" \
  NEARBYTES_BENCH_SWARM_TIMEOUT_MS="${NEARBYTES_BENCH_SWARM_TIMEOUT_MS:-}" \
  NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS="${NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS:-}" \
  node dist/sync-benchmark.js >>"${REMOTE_LOG}" 2>&1 &
echo \$! > "${BENCH_BASE_REMOTE}/bob/bench.pid"
echo RECEIVER_DETACHED
REMOTE
heartbeat "receiver detached (log: ${REMOTE_LOG})"
countdown "$BENCH_COUNTDOWN_SEC" "sender start"

progress "Start sender (alice) on this machine"
set +e
NEARBYTES_BENCH_ROLE=sender \
NEARBYTES_BENCH_PROFILE="${NEARBYTES_BENCH_PROFILE:-}" \
NEARBYTES_BENCH_QUICK="${NEARBYTES_BENCH_QUICK:-}" \
NEARBYTES_BENCH_DISCOVERY_MS="${NEARBYTES_BENCH_DISCOVERY_MS:-}" \
NEARBYTES_BENCH_GRACE_MS="${NEARBYTES_BENCH_GRACE_MS:-}" \
NEARBYTES_BENCH_SWARM_TIMEOUT_MS="${NEARBYTES_BENCH_SWARM_TIMEOUT_MS:-}" \
NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS="${NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS:-}" \
NEARBYTES_BENCH_BASE="${BENCH_BASE_LOCAL}" \
NEARBYTES_BENCH_OUT="${BENCH_BASE_LOCAL}/alice/benchmark-result.json" \
  node "$ROOT/dist/sync-benchmark.js" 2>&1 | stream_lines '[local]'
SENDER_EXIT=${PIPESTATUS[0]}
set -e

progress "Wait for receiver result on ${REMOTE_HOST}"
RECV_EXIT=0
RECV_WAIT_START=$SECONDS
RECV_DEADLINE=$((RECV_WAIT_START + BENCH_RECV_DEADLINE_SEC))
SSH_FAILS=0
until ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "test -f '${REMOTE_RESULT}'" >/dev/null 2>&1; do
  SSH_STATUS=$?
  if (( SSH_STATUS != 0 )); then
    SSH_FAILS=$((SSH_FAILS + 1))
    if (( SSH_FAILS >= 3 )); then
      echo "SSH to ${REMOTE_HOST} failed ${SSH_FAILS} times (unreachable?) — aborting wait."
      RECV_EXIT=1
      break
    fi
  else
    SSH_FAILS=0
  fi
  if (( SECONDS > RECV_DEADLINE )); then
    echo "Receiver timed out after ${BENCH_RECV_DEADLINE_SEC}s — last log lines:"
    poll_remote_log "$REMOTE_LOG"
    RECV_EXIT=1
    break
  fi
  heartbeat "receiver — polling log + waiting for result"
  poll_remote_log "$REMOTE_LOG"
  sleep "${BENCH_POLL_SEC}"
done
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" 'pkill -f "node dist/sync-benchmark" 2>/dev/null; true'
poll_remote_log "$REMOTE_LOG"

progress "Fetch receiver JSON + merge results"
mkdir -p "$OUT_DIR"
heartbeat "scp receiver-result.json"
scp "${REMOTE_HOST}:${REMOTE_RESULT}" "$OUT_DIR/receiver-result.json"

SENDER_JSON="${BENCH_BASE_LOCAL}/alice/benchmark-result.json"
MANIFEST_JSON="${BENCH_BASE_LOCAL}/alice/trial-manifest.json"
RECEIVER_JSON="$OUT_DIR/receiver-result.json"

heartbeat "merge results"
node "$ROOT/scripts/merge-benchmark-results.mjs" \
  --sender "$SENDER_JSON" \
  --manifest "$MANIFEST_JSON" \
  --receiver "$RECEIVER_JSON" \
  --out "$OUT_DIR/bench-report.json" | stream_lines '[merge]'

FIG_DIR="${NEARBYTES_REPORT_FIGURES_DIR:-$ROOT/.local/bench/figures}"
if [[ "${NEARBYTES_BENCH_SKIP_FIGURES:-}" != "1" ]]; then
  heartbeat "render LaTeX figures"
  node "$ROOT/scripts/render-benchmark-figures.mjs" \
    --report "$OUT_DIR/bench-report.json" \
    --outdir "$FIG_DIR" || heartbeat "figure render skipped (non-fatal)"
fi

progress "Done"
if [[ "$SENDER_EXIT" -ne 0 || "$RECV_EXIT" -ne 0 ]]; then
  echo "FAILED: sender exit=$SENDER_EXIT receiver exit=$RECV_EXIT"
  exit 1
fi
echo "SUCCESS: report at $OUT_DIR/bench-report.json (total $((SECONDS - RUN_START))s)"
