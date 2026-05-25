#!/usr/bin/env node
/**
 * Stress large-stream sync until 3× campaign goodput (1 / 32 / 128 MiB) passes.
 *   node scripts/sync-large-loop.mjs
 *   node scripts/sync-large-loop.mjs --max-attempts 20
 */

import { spawn } from 'child_process';
import { mkdir, rm } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { killStaleBenchProcesses } from '../tests/e2e/lib/spawn-bench.mjs';
import { ensureBenchmarkBuilt } from './ensure-built.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const maxAttempts = Number(process.argv.includes('--max-attempts')
  ? process.argv[process.argv.indexOf('--max-attempts') + 1]
  : 10);

const env = {
  ...process.env,
  NEARBYTES_BENCH_PROFILE: 'campaign',
  NEARBYTES_BENCH_LATENCY_REPEATS: '1',
  NEARBYTES_BENCH_LATENCY_WARMUP: '0',
  NEARBYTES_BENCH_STREAM_SIZES: '1048576,33554432,134217728',
  NEARBYTES_BENCH_DISCOVERY_MS: '2000',
  NEARBYTES_BENCH_GRACE_MS: '500',
  NEARBYTES_BENCH_STREAM_INTER_MS: '500',
  NEARBYTES_BENCH_LATENCY_TIMEOUT_MS: '0',
  NEARBYTES_BENCH_THROUGHPUT_TIMEOUT_MS: '0',
  NEARBYTES_BENCH_SKIP_FIGURES: '1',
};

async function runOnce(attempt) {
  killStaleBenchProcesses();
  const work = path.join(root, '.local/sync-large-loop', `attempt-${attempt}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const runBase = path.join(work, 'campaign');
  const bob = spawn(
    process.execPath,
    [path.join(root, 'dist/sync-benchmark.js')],
    {
      cwd: root,
      env: {
        ...env,
        NEARBYTES_BENCH_ROLE: 'receiver',
        NEARBYTES_BENCH_BASE: runBase,
        NEARBYTES_BENCH_OUT: path.join(runBase, 'bob/benchmark-result.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  await new Promise((r) => setTimeout(r, 250));
  const alice = spawn(
    process.execPath,
    [path.join(root, 'dist/sync-benchmark.js')],
    {
      cwd: root,
      env: {
        ...env,
        NEARBYTES_BENCH_ROLE: 'sender',
        NEARBYTES_BENCH_BASE: runBase,
        NEARBYTES_BENCH_OUT: path.join(runBase, 'alice/benchmark-result.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const deadline = Date.now() + 180_000;
  const tail = (stream) => {
    let buf = '';
    stream.on('data', (c) => {
      buf = (buf + c).slice(-4000);
    });
    return () => buf;
  };
  const bobTail = tail(bob.stderr);
  const aliceTail = tail(alice.stderr);

  const codes = await Promise.all([
    new Promise((res) => bob.on('exit', (c) => res(c ?? 1))),
    new Promise((res) => alice.on('exit', (c) => res(c ?? 1))),
  ]);

  if (codes[0] !== 0 || codes[1] !== 0) {
    return {
      ok: false,
      reason: `exit bob=${codes[0]} alice=${codes[1]}`,
      stderr: `${bobTail()}\n${aliceTail()}`,
    };
  }

  const { readFile } = await import('fs/promises');
  const mergePath = path.join(work, 'bench-report.json');
  await new Promise((res, rej) => {
    const m = spawn(
      process.execPath,
      [
        path.join(root, 'scripts/merge-benchmark-results.mjs'),
        '--sender',
        path.join(runBase, 'alice/benchmark-result.json'),
        '--manifest',
        path.join(runBase, 'alice/trial-manifest.json'),
        '--receiver',
        path.join(runBase, 'bob/benchmark-result.json'),
        '--out',
        mergePath,
        '--topology',
        'sync-large-loop',
      ],
      { cwd: root, stdio: 'inherit' },
    );
    m.on('exit', (c) => (c === 0 ? res() : rej(new Error(`merge ${c}`))));
  });

  const report = JSON.parse(await readFile(mergePath, 'utf-8'));
  const streams = report.goodputTable ?? [];
  const expected = [1048576, 33554432, 134217728];
  for (const size of expected) {
    const row = streams.find((r) => r.sizeBytes === size);
    if (!row || row.goodputMbps == null || !Number.isFinite(row.goodputMbps)) {
      return {
        ok: false,
        reason: `missing goodput for ${size} B`,
        stderr: bobTail(),
      };
    }
  }
  return { ok: true, report };
}

await ensureBenchmarkBuilt();
await mkdir(path.join(root, '.local/sync-large-loop'), { recursive: true });

for (let i = 1; i <= maxAttempts; i++) {
  const t0 = Date.now();
  console.log(`\n═══ sync-large-loop attempt ${i}/${maxAttempts} ═══`);
  const result = await runOnce(i);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (result.ok) {
    console.log(`PASS in ${sec}s — 1/32/128 MiB goodput OK`);
    process.exit(0);
  }
  console.error(`FAIL in ${sec}s — ${result.reason}`);
  if (result.stderr) {
    console.error(result.stderr.slice(-2000));
  }
}

console.error(`\nsync-large-loop: failed after ${maxAttempts} attempts`);
process.exit(1);
