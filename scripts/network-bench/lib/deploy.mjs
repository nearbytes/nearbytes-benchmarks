/**
 * Idempotent remote bootstrap for the network-bench.
 *
 *   await ensureRemoteWorkspace(sshAlias, workdir);
 *
 * 1. rsyncs the six nearbytes-* source trees from this Mac to `workdir`
 *    on the target (excluding `node_modules`, `dist`, `.yarn`, `.git`).
 * 2. ensures a user-local Node ≥ 20.10 lives under
 *    `${workdir}/.toolchain/node/`. Node 20 is required because
 *    `nearbytes-skeleton` uses recursive `fs.watch`, which is unsupported
 *    on Linux in Node ≤ 19.
 * 3. installs deps with yarn 1 (via npx) — npm v9 on stock Debian/Ubuntu
 *    Node has a known bug placing transitive `file:` deps; yarn 1 sidesteps
 *    it with symlinks.
 * 4. builds with `npm run build`, skipping when `dist/` is newer than
 *    every `src/**` file.
 *
 * rsync (not git clone) is used because the Nearbytes GitHub repos are
 * private and the remotes lack credentials; this also lets the harness
 * ship work-in-progress that hasn't been pushed yet.
 *
 * Cost: ~30s rsync + ~3 min first time for native compiles
 * (sodium-native, libutp, etc.); <10 s on subsequent runs.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sshRun } from './remote.mjs';

/** Dependency order — leaves first. */
export const NB_REPOS = [
  'nearbytes-crypto',
  'nearbytes-log',
  'nearbytes-sync',
  'nearbytes-skeleton',
  'nearbytes-files',
  'nearbytes-benchmarks',
];

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOS_ROOT = resolve(HERE, '..', '..', '..', '..');

/** rsync one source repo to remoteDir; excludes build artefacts. */
function rsyncRepo(repo, sshAlias, remoteDir) {
  return new Promise((resolve, reject) => {
    const src = `${REPOS_ROOT}/${repo}/`;
    const dst = `${sshAlias}:${remoteDir}/${repo}/`;
    const args = [
      '-az', '--delete',
      '--exclude=node_modules', '--exclude=dist', '--exclude=.yarn',
      '--exclude=.git', '--exclude=.local', '--exclude=results',
      '--exclude=*.log',
      '-e', 'ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15',
      src, dst,
    ];
    const child = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rsync ${repo} → ${sshAlias} exit ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

/** Shell snippet that, when sourced on the remote with the source trees
 *  already rsync'd, installs deps + builds in dependency order.
 *
 *  - TMPDIR is redirected to $HOME/tmp because some bench hosts run with
 *    a critically-full root partition (zombie: / at 100%).
 *  - Installs use yarn 1.22 via npx. npm v9 — the version shipped on
 *    Debian/Ubuntu Node 18 — has a known bug placing transitive `file:`
 *    deps (ENOENT on the hoisted node_modules/<dep>/package.json).
 *    Yarn 1 sidesteps this by symlinking file: deps directly. */
const NODE_VERSION = '20.19.4';

function buildScript(workdir) {
  return `
set -euo pipefail
export TMPDIR="$HOME/tmp"
mkdir -p "$TMPDIR"
cd ${shq(workdir)}

# --- 1. user-local Node ${NODE_VERSION} ---------------------------------------
TOOL=${shq(workdir + '/.toolchain')}
NODE_HOME="$TOOL/node-v${NODE_VERSION}-linux-x64"
if [ ! -x "$NODE_HOME/bin/node" ]; then
  mkdir -p "$TOOL"
  echo "==> downloading Node ${NODE_VERSION}…"
  curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz -o "$TOOL/node.tar.xz"
  tar -xJf "$TOOL/node.tar.xz" -C "$TOOL"
  rm -f "$TOOL/node.tar.xz"
fi
export PATH="$NODE_HOME/bin:$PATH"
node --version | sed 's/^/node: /'

# --- 2. install + build each repo --------------------------------------------
build_if_stale() {
  local repo="$1"
  echo "==> $repo"
  cd "$repo"
  if [ ! -d node_modules ]; then
    rm -f package-lock.json yarn.lock
    npx --yes yarn@1.22.22 install --no-progress --ignore-engines --non-interactive 2>&1 | tail -3
  fi
  if [ ! -d dist ] || [ -n "$(find src package.json tsconfig.json -newer dist -print -quit 2>/dev/null)" ]; then
    npm run build --silent 2>&1 | tail -3
  fi
  cd ..
}

for r in ${NB_REPOS.join(' ')}; do
  build_if_stale "$r"
done

node -e "
const fs=require('fs');
const must=['nearbytes-benchmarks/dist/scripts/network-peer.js'];
for(const p of must){ if(!fs.existsSync(p)){ console.error('missing:'+p); process.exit(1); } }
console.log('bootstrap-ok');
"
`;
}

export const REMOTE_NODE_BIN = (workdir) => `${workdir}/.toolchain/node-v${NODE_VERSION}-linux-x64/bin/node`;

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Push the source trees + build them on `sshAlias`. Logs progress to stderr. */
export async function ensureRemoteWorkspace(sshAlias, workdir, { verbose = true } = {}) {
  const log = (m) => verbose && process.stderr.write(`[deploy ${sshAlias}] ${m}\n`);
  log(`rsync → ${workdir}/`);
  const t0 = Date.now();
  await sshRun(sshAlias, `mkdir -p ${shq(workdir)}`);
  // rsync repos sequentially so the link state stays sane if interrupted.
  for (const repo of NB_REPOS) {
    await rsyncRepo(repo, sshAlias, workdir);
  }
  log(`rsync done in ${((Date.now() - t0) / 1000).toFixed(1)}s — building…`);
  const tBuild = Date.now();
  const { stdout, stderr } = await sshRun(sshAlias, 'bash -s', {
    stdin: buildScript(workdir),
    timeoutMs: 900_000,
  });
  const tail = (stderr.trim() || stdout.trim()).split('\n').slice(-5).join(' | ');
  const ok = stdout.includes('bootstrap-ok');
  log(`build done in ${((Date.now() - tBuild) / 1000).toFixed(1)}s — ${ok ? 'OK' : 'FAIL'} (${tail})`);
  if (!ok) throw new Error(`bootstrap failed on ${sshAlias}: ${tail}`);
  return { workdir, sshAlias };
}
