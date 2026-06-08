#!/usr/bin/env node
/**
 * Run protocol benchmarks needed for the paper, then invoke yarn paper:update.
 *
 *   yarn bench:paper              # full (local + wan + opt-ablation; LAN must exist)
 *   NEARBYTES_PAPER_BENCH_SMOKE=1 yarn bench:paper   # validate pipeline only
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { validateBenchData } from './lib/bench-sanity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BENCH = join(REPO, '.local', 'bench');
const PROTO = join(BENCH, 'protocol');
const SMOKE = process.env.NEARBYTES_PAPER_BENCH_SMOKE === '1';

const PAPER_ROOT = [
  resolve(REPO, '..', '..', 'NEARBYTES-PAPERS', 'paper-nearbytes-hypercore'),
  resolve(REPO, '..', '..', 'NEARBYTES', 'NEARBYTES-PAPERS', 'paper-nearbytes-hypercore'),
].find((p) => existsSync(join(p, 'paper.tex')));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd ?? REPO, env: process.env });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status ?? 'signal'})`);
  }
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

  if (SMOKE) {
    console.log('SMOKE: skip benchmark runs, validate + paper:update only');
  } else {
    run('yarn', ['build']);
    run('node', ['scripts/protocol-bench/run-transfer-matrix.mjs', '--', '--categories', 'local', '--out', join(PROTO, 'transfer-matrix-local.json')]);
    await promote('transfer-matrix-local.json', 'transfer-matrix-local-full.json');

    run('node', ['scripts/protocol-bench/run-optimization-ablation.mjs', '--out', join(PROTO, 'opt-ablation-local.json')]);

    run('node', ['scripts/protocol-bench/run-transfer-matrix.mjs', '--', '--categories', 'wan', '--out', join(PROTO, 'transfer-matrix-wan.json')]);
    await promote('transfer-matrix-wan.json', 'transfer-matrix-wan-full.json');

    const lanFull = join(PROTO, 'transfer-matrix-lan-full.json');
    if (!existsSync(lanFull)) {
      throw new Error(`missing ${lanFull} — run yarn bench:protocol:lan and yarn bench:protocol:transfer-matrix:lan:pull first`);
    }
  }

  const v = validateBenchData(BENCH);
  if (!v.ok) {
    console.error('bench sanity check failed before paper update:');
    for (const e of v.errors) console.error(`  • ${e}`);
    process.exit(1);
  }

  if (!PAPER_ROOT) throw new Error('paper-nearbytes-hypercore not found');
  run('yarn', ['paper:update', '--source', BENCH], { cwd: PAPER_ROOT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
