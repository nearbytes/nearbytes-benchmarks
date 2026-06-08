#!/usr/bin/env node
/**
 * Paper evaluation pipeline — each phase maps to a figure claim in the paper.
 *
 *   yarn bench:paper
 *   NEARBYTES_PAPER_BENCH_SMOKE=1 yarn bench:paper   # validate + paper:update only
 *
 * Claims exercised:
 *   C1  localhost campaign (figures/benchmark-*.tex) — optional if campaign JSON present
 *   C2  small-payload latency (fig:bench-network-latency-small) — network-bench small
 *   C3  throughput goodput (fig:bench-network-goodput) — transfer-matrix large+burst
 *   C4  geometry sensitivity (tab:transfer-matrix-*) — transfer-matrix all rows
 *   C5  encode/decode cost (tab:transfer-matrix-resources) — transfer-matrix resources
 *   C6  optimization ablation (tab:opt-ablation) — opt-ablation-local
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { validateBenchData } from './lib/bench-sanity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BENCH = join(REPO, '.local', 'bench');
const PROTO = join(BENCH, 'protocol');
const NET = join(BENCH, 'network');
const SMOKE = process.env.NEARBYTES_PAPER_BENCH_SMOKE === '1';
const SKIP_LAN = process.env.NEARBYTES_PAPER_SKIP_LAN === '1';
const SKIP_WAN = process.env.NEARBYTES_PAPER_SKIP_WAN === '1';

const PAPER_ROOT = [
  resolve(REPO, '..', '..', 'NEARBYTES-PAPERS', 'paper-nearbytes-hypercore'),
  resolve(REPO, '..', '..', 'NEARBYTES', 'NEARBYTES-PAPERS', 'paper-nearbytes-hypercore'),
].find((p) => existsSync(join(p, 'paper.tex')));

const manifest = {
  startedAt: new Date().toISOString(),
  smoke: SMOKE,
  phases: [],
};

function run(cmd, args, opts = {}) {
  const label = opts.label ?? `${cmd} ${args.join(' ')}`;
  console.log(`\n── ${label} ──`);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd ?? REPO, env: process.env });
  const entry = {
    label,
    ok: r.status === 0,
    exit: r.status,
    ms: Date.now() - t0,
  };
  manifest.phases.push(entry);
  if (!entry.ok && opts.required !== false) {
    throw new Error(`${label} failed (exit ${r.status ?? 'signal'})`);
  }
  return entry;
}

async function promote(srcName, dstName) {
  const src = join(PROTO, srcName);
  const dst = join(PROTO, dstName);
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  await copyFile(src, dst);
  console.log(`promoted ${srcName} → ${dstName}`);
}

async function main() {
  await mkdir(PROTO, { recursive: true });
  await mkdir(NET, { recursive: true });

  if (!SMOKE) {
    run('yarn', ['build']);

    // C2: small-payload latency only (large/burst goodput comes from transfer-matrix)
    const netEnv = { ...process.env, NEARBYTES_NETBENCH_CLASSES: 'small' };
    const netRun = (script, label, required = true) => {
      console.log(`\n── ${label} ──`);
      const t0 = Date.now();
      const r = spawnSync('node', [script], { stdio: 'inherit', cwd: REPO, env: netEnv });
      manifest.phases.push({ label, ok: r.status === 0, exit: r.status, ms: Date.now() - t0 });
      if (r.status !== 0 && required) throw new Error(`${label} failed`);
    };
    netRun('scripts/network-bench/run-local.mjs', 'C2 network-bench local (small only)');
    if (!SKIP_LAN) netRun('scripts/network-bench/run-lan.mjs', 'C2 network-bench LAN (small only)', false);
    if (!SKIP_WAN) netRun('scripts/network-bench/run-wan.mjs', 'C2 network-bench WAN (small only)', false);

    // C3–C5: transfer matrix (throughput + resources + network goodput fig)
    run('node', [
      'scripts/protocol-bench/run-transfer-matrix.mjs',
      '--',
      '--categories',
      'local',
      '--out',
      join(PROTO, 'transfer-matrix-local.json'),
    ], { label: 'C3–C5 transfer-matrix local' });
    await promote('transfer-matrix-local.json', 'transfer-matrix-local-full.json');

    run('node', ['scripts/protocol-bench/run-optimization-ablation.mjs', '--out', join(PROTO, 'opt-ablation-local.json')], {
      label: 'C6 opt-ablation local',
    });

    if (!SKIP_WAN) {
      run('node', [
        'scripts/protocol-bench/run-transfer-matrix.mjs',
        '--',
        '--categories',
        'wan',
        '--out',
        join(PROTO, 'transfer-matrix-wan.json'),
      ], { label: 'C3–C5 transfer-matrix WAN' });
      await promote('transfer-matrix-wan.json', 'transfer-matrix-wan-full.json');
    }

    const lanFull = join(PROTO, 'transfer-matrix-lan-full.json');
    if (!SKIP_LAN) {
      if (!existsSync(lanFull)) {
        run('bash', ['scripts/protocol-bench/pull-transfer-matrix-lan.sh'], {
          label: 'C3–C5 transfer-matrix LAN pull',
          required: false,
        });
      }
    }
    if (!existsSync(lanFull)) {
      console.warn(`WARN: missing ${lanFull} — paper will fail validation without LAN matrix`);
    }
  }

  const v = validateBenchData(BENCH);
  manifest.validation = v;
  if (!v.ok) {
    console.error('bench sanity check failed:');
    for (const e of v.errors) console.error(`  • ${e}`);
    process.exit(1);
  }

  if (!PAPER_ROOT) throw new Error('paper-nearbytes-hypercore not found');
  run('yarn', ['paper:update', '--source', BENCH], { cwd: PAPER_ROOT, label: 'paper:update' });

  run('node', ['scripts/paper-eval-summary.mjs'], { label: 'evaluation summary', required: false });

  manifest.finishedAt = new Date().toISOString();
  await writeFile(join(BENCH, 'paper-eval-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nmanifest → ${join(BENCH, 'paper-eval-manifest.json')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
