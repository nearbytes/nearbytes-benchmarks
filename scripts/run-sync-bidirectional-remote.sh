#!/usr/bin/env bash
# Run bidirectional sync: this machine = alice, pc-ciancia = bob.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_HOST="${NEARBYTES_REMOTE_HOST:-pc-ciancia}"
REMOTE_DIR="${NEARBYTES_REMOTE_DIR:-}"
REPOS_BASE="${NEARBYTES_REPOS:-https://github.com/nearbytes}"

run_yarn() {
  if command -v yarn >/dev/null 2>&1; then
    yarn "$@"
  else
    corepack prepare yarn@4.5.1 --activate
    yarn "$@"
  fi
}

build_repo() {
  local dir="$1"
  cd "$dir"
  if [[ -f yarn.lock ]]; then
    run_yarn install
    run_yarn build
  else
    npm install --no-fund --no-audit
    npm run build
  fi
}

clone_deps() {
  local dir="$1"
  mkdir -p "$dir"
  for repo in nearbytes-crypto nearbytes-log nearbytes-sync nearbytes-skeleton nearbytes-files; do
    if [[ ! -d "$dir/$repo/.git" ]]; then
      git clone --depth 1 "$REPOS_BASE/${repo}.git" "$dir/$repo"
    else
      git -C "$dir/$repo" pull --ff-only || true
    fi
  done
}

echo "==> Local build (alice)"
cd "$ROOT"
run_yarn install
run_yarn build

echo "==> Remote setup (bob) on $REMOTE_HOST"
ssh "$REMOTE_HOST" "bash -s" <<REMOTE
set -euo pipefail
REMOTE_DIR="${NEARBYTES_REMOTE_DIR:-\$HOME/nearbytes-sync-test}"
REPOS_BASE="${REPOS_BASE}"
run_yarn() {
  if command -v yarn >/dev/null 2>&1; then
    yarn "\$@"
  else
    export COREPACK_HOME="\$REMOTE_DIR/.corepack"
    mkdir -p "\$COREPACK_HOME"
    export COREPACK_HOME="\$REMOTE_DIR/.corepack"
    mkdir -p "\$COREPACK_HOME"
    corepack prepare yarn@4.5.1 --activate
    corepack yarn "\$@"
  fi
}
build_repo() {
  local dir="\$1"
  cd "\$dir"
  if [[ -f yarn.lock ]]; then
    run_yarn install
    run_yarn build
  else
    npm install --no-fund --no-audit
    npm run build
  fi
}
mkdir -p "\$REMOTE_DIR"
cd "\$REMOTE_DIR"
for repo in nearbytes-crypto nearbytes-log nearbytes-sync nearbytes-skeleton nearbytes-files; do
  if [[ ! -d "\$repo/.git" ]]; then
    git clone --depth 1 "\$REPOS_BASE/\${repo}.git" "\$repo"
  else
    git -C "\$repo" pull --ff-only || true
  fi
done
for repo in nearbytes-crypto nearbytes-log nearbytes-sync nearbytes-skeleton nearbytes-files; do
  build_repo "\$REMOTE_DIR/\$repo"
done
REMOTE

echo "==> Starting bob on $REMOTE_HOST (background)"
ssh "$REMOTE_HOST" 'cd "${NEARBYTES_REMOTE_DIR:-$HOME/nearbytes-sync-test}/nearbytes-files" && NEARBYTES_TEST_ROLE=bob NEARBYTES_TEST_TIMEOUT_MS=240000 node dist/scripts/sync-bidirectional-test.js' &
BOB_PID=$!
sleep 8

echo "==> Starting alice (this machine)"
NEARBYTES_TEST_ROLE=alice NEARBYTES_TEST_TIMEOUT_MS=240000 \
  node "$ROOT/dist/scripts/sync-bidirectional-test.js"
ALICE_EXIT=$?

wait "$BOB_PID" || BOB_EXIT=$?
BOB_EXIT=${BOB_EXIT:-0}

if [[ "$BOB_EXIT" -ne 0 || "$ALICE_EXIT" -ne 0 ]]; then
  echo "Remote bidirectional test failed: alice=$ALICE_EXIT bob=$BOB_EXIT"
  exit 1
fi
echo "Remote bidirectional sync test passed."
