#!/usr/bin/env node
/**
 * Paper evaluation pipeline — parallel where safe, skip fresh artifacts.
 *
 *   yarn bench:paper                              # ≤60s hard cap per measurement (bench-timing.mjs)
 *   NEARBYTES_PAPER_BENCH_SMOKE=1 yarn bench:paper
 *   NEARBYTES_PAPER_FORCE=1 yarn bench:paper        # ignore freshness
 *   NEARBYTES_PAPER_SKIP_LAN=1 / SKIP_WAN=1         # skip remote categories
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { validateBenchData } from './lib/bench-sanity.mjs';
import { isFreshFile, isFreshTransferMatrix, isForced } from './lib/bench-fresh.mjs';
import {
  ablationArgv,
  ablationEnv,
  profileLabel,
  transferMatrixArgv,
  transferMatrixEnv,
} from './lib/paper-bench-profile.mjs';
import { killStrayProtocolPeers } from './protocol-bench/lib/protocol-pair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BENCH = join(REPO, '.local', 'bench');
const PROTO = join(BENCH, 'protocol');
const NET = join(BENCH, 'network');
const SMOKE = process.env.NEARBYTES_PAPER_BENCH_SMOKE === '1';
const SKIP_LAN = process.env.NEARBYTES_PAPER_SKIP_LAN === '1';
const SKIP_WAN = process.env.NEARBYTES_PAPER_SKIP_WAN === '1';
const NET_SMALL = { NEARBYTES_NETBENCH_CLASSES: 'small' };

const PAPER_ROOT = [
  resolve(REPO, '..', '..', 'NEARBYTES-PAPERS', 'paper-nearbytes-hypercore'),
  resolve(REPO, '..', '..', 'NEARBYTES', 'NEARBYTES-PAPERS', 'paper-nearbytes-hypercore'),
].find((p) => existsSync(join(p, 'paper.tex')));

const ABL_ENV = ablationEnv();
const tmEnv = (cat) => transferMatrixEnv(cat);
const tmArgs = (cat) => transferMatrixArgv(cat);

const manifest = {
  startedAt: new Date().toISOString(),
  smoke: SMOKE,
  force: isForced(),
  profile: profileLabel(),
  phases: [],
};

function spawnJob(cmd, args, { label, cwd = REPO, env = {}, required = true } = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n── ${label} ──`);
    const t0 = Date.now();
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      cwd,
      env: { ...process.env, ...env },
    });
    child.on('close', (code) => {
      const entry = { label, ok: code === 0, exit: code, ms: Date.now() - t0 };
      manifest.phases.push(entry);
      if (code !== 0 && required) reject(new Error(`${label} failed (exit ${code})`));
      else resolve(entry);
    });
  });
}

async function promote(srcName, dstName) {
  const src = join(PROTO, srcName);
  const dst = join(PROTO, dstName);
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  await copyFile(src, dst);
  console.log(`promoted ${srcName} → ${dstName}`);
}

async function promoteLanFromPull() {
  const metaPath = join(REPO, '.local', 'tmp', 'transfer_lan_run.meta');
  if (!existsSync(metaPath)) return false;
  const meta = await readFile(metaPath, 'utf8');
  const localOut = meta.split('\n').map((l) => l.match(/^local_out=(.+)$/)).find(Boolean)?.[1];
  if (!localOut || !existsSync(localOut)) return false;
  const lanFull = join(PROTO, 'transfer-matrix-lan-full.json');
  await copyFile(localOut, lanFull);
  await copyFile(localOut, join(PROTO, 'transfer-matrix-lan.json'));
  console.log(`promoted ${localOut} → transfer-matrix-lan-full.json`);
  return true;
}

async function ensureLanMatrix(needRun) {
  const lanFull = join(PROTO, 'transfer-matrix-lan-full.json');
  if (!needRun && isFreshTransferMatrix(lanFull)) {
    console.log('skip LAN transfer-matrix (fresh complete)');
    return;
  }
  if (SKIP_LAN) {
    if (!existsSync(lanFull)) {
      throw new Error(`missing ${lanFull} — set NEARBYTES_PAPER_SKIP_LAN=0 or provide stale data`);
    }
    return;
  }
  if (needRun) {
    await spawnJob('bash', ['scripts/protocol-bench/run-transfer-matrix-lan-detached.sh'], {
      label: 'C3–C5 transfer-matrix LAN launch',
      env: {
        ...tmEnv('lan'),
        NEARBYTES_LAN_SKIP_DEPLOY: '1',
        NEARBYTES_LAN_REMOTE_MAX_ATTEMPTS: '1',
      },
    });
    await spawnJob('bash', ['scripts/protocol-bench/wait-transfer-matrix-lan-remote.sh'], {
      label: 'C3–C5 transfer-matrix LAN wait',
      env: { NEARBYTES_LAN_POLL_SEC: '15', NEARBYTES_LAN_WAIT_MAX_SEC: '900' },
    });
  }
  await spawnJob('bash', ['scripts/protocol-bench/pull-transfer-matrix-lan.sh'], {
    label: 'C3–C5 transfer-matrix LAN pull',
    required: false,
  });
  if (!await promoteLanFromPull() && !existsSync(lanFull)) {
    throw new Error(`missing ${lanFull} — LAN pull failed or run incomplete`);
  }
}

async function writeManifest(exitCode = 0) {
  manifest.finishedAt = new Date().toISOString();
  manifest.exitCode = exitCode;
  await mkdir(BENCH, { recursive: true });
  await writeFile(join(BENCH, 'paper-eval-manifest.json'), JSON.stringify(manifest, null, 2));
}

async function main() {
  let exitCode = 0;
  try {
    await mkdir(PROTO, { recursive: true });
    await mkdir(NET, { recursive: true });

    if (!SMOKE) {
      if (process.env.NEARBYTES_PAPER_BENCH_FULL === '1') {
        console.warn('NEARBYTES_PAPER_BENCH_FULL is deprecated — hard 60s cap always applies (bench-timing.mjs)');
      }
      console.log(`bench profile: ${profileLabel()}`);
      killStrayProtocolPeers();
      await spawnJob('yarn', ['build'], { label: 'build' });

      const localTmOut = join(PROTO, 'transfer-matrix-local.json');
      const localTmFull = join(PROTO, 'transfer-matrix-local-full.json');
      const wanTmOut = join(PROTO, 'transfer-matrix-wan.json');
      const wanTmFull = join(PROTO, 'transfer-matrix-wan-full.json');
      const optOut = join(PROTO, 'opt-ablation-local.json');

      // Local harnesses share protocol-peer processes — run sequentially to avoid port/CPU contention.
      if (!isFreshFile(join(NET, 'local-results.json'))) {
        await spawnJob('node', ['scripts/network-bench/run-local.mjs'], {
          label: 'C2 network local (small)',
          env: NET_SMALL,
        });
      } else {
        console.log('skip network local (fresh)');
      }

      if (!isFreshTransferMatrix(localTmFull) && !isFreshFile(localTmOut)) {
        await spawnJob('node', [
          'scripts/protocol-bench/run-transfer-matrix.mjs',
          '--',
          '--categories', 'local',
          '--out', localTmOut,
          ...tmArgs('local'),
        ], { label: 'C3–C5 transfer-matrix local', env: tmEnv('local') });
        await promote('transfer-matrix-local.json', 'transfer-matrix-local-full.json');
      } else {
        console.log('skip transfer-matrix local (fresh)');
        if (!existsSync(localTmFull) && existsSync(localTmOut)) {
          await promote('transfer-matrix-local.json', 'transfer-matrix-local-full.json');
        }
      }

      if (!isFreshFile(optOut)) {
        await spawnJob('node', ['scripts/protocol-bench/run-optimization-ablation.mjs', ...ablationArgv(optOut)], {
          label: 'C6 opt-ablation',
          env: ABL_ENV,
        });
      } else {
        console.log('skip opt-ablation (fresh)');
      }

      if (!existsSync(localTmFull) && existsSync(localTmOut)) {
        await promote('transfer-matrix-local.json', 'transfer-matrix-local-full.json');
      }

      const needLanNet = !SKIP_LAN && !isFreshFile(join(NET, 'lan-results.json'));
      const needWanNet = !SKIP_WAN && !isFreshFile(join(NET, 'wan-results.json'));
      const needWanTm = !SKIP_WAN && !isFreshTransferMatrix(wanTmFull) && !isFreshFile(wanTmOut);
      const needLanTm = !SKIP_LAN && !isFreshTransferMatrix(join(PROTO, 'transfer-matrix-lan-full.json'));
      const needRemote = needLanNet || needWanNet || needWanTm || needLanTm;
      if (needRemote) {
        await spawnJob('node', ['scripts/network-bench/deploy-remotes.mjs'], {
          label: 'deploy remotes (once)',
        });
      } else {
        console.log('skip deploy (all remote artifacts fresh)');
      }

      const wave2 = [];
      if (needLanNet) {
        wave2.push(spawnJob('node', ['scripts/network-bench/run-lan.mjs', '--skip-deploy'], {
          label: 'C2 network LAN (small)',
          env: NET_SMALL,
          required: false,
        }));
      } else if (!SKIP_LAN) {
        console.log('skip network LAN (fresh)');
      }

      if (needWanNet) {
        wave2.push(spawnJob('node', ['scripts/network-bench/run-wan.mjs', '--skip-deploy'], {
          label: 'C2 network WAN (small)',
          env: NET_SMALL,
          required: false,
        }));
      } else if (!SKIP_WAN) {
        console.log('skip network WAN (fresh)');
      }

      if (needWanTm) {
        wave2.push(
          spawnJob('node', [
            'scripts/protocol-bench/run-transfer-matrix.mjs',
            '--',
            '--categories', 'wan',
            '--skip-deploy',
            '--out', wanTmOut,
            ...tmArgs('wan'),
          ], { label: 'C3–C5 transfer-matrix WAN', env: tmEnv('wan') }).then(() => promote('transfer-matrix-wan.json', 'transfer-matrix-wan-full.json')),
        );
      } else if (!SKIP_WAN) {
        console.log('skip transfer-matrix WAN (fresh)');
      }

      if (wave2.length) await Promise.all(wave2);
      if (!existsSync(wanTmFull) && existsSync(wanTmOut)) {
        await promote('transfer-matrix-wan.json', 'transfer-matrix-wan-full.json');
      }

      await ensureLanMatrix(needLanTm);
    }

    const v = validateBenchData(BENCH);
    manifest.validation = v;
    if (!v.ok) {
      console.error('bench sanity check failed:');
      for (const e of v.errors) console.error(`  • ${e}`);
      exitCode = 1;
      return;
    }

    if (!PAPER_ROOT) throw new Error('paper-nearbytes-hypercore not found');
    await spawnJob('yarn', ['paper:update', '--source', BENCH], {
      cwd: PAPER_ROOT,
      label: 'paper:update',
    });
    await spawnJob('node', ['scripts/paper-eval-summary.mjs'], {
      label: 'evaluation summary',
      required: false,
    });
  } catch (err) {
    console.error(err);
    exitCode = 1;
  } finally {
    await writeManifest(exitCode);
    console.log(`\nmanifest → ${join(BENCH, 'paper-eval-manifest.json')}`);
    if (exitCode) process.exit(exitCode);
  }
}

main();
