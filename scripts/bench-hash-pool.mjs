#!/usr/bin/env node
/**
 * Streaming SHA-256 microbenchmark.
 *
 * Streams N independent payloads of size S through `acquireSha256Stream()`
 * concurrently and reports aggregate wall-clock hashing throughput. The
 * pool capacity (K = number of long-lived worker threads) is fixed at
 * process start via `NEARBYTES_HASH_POOL_CAPACITY`, so to sweep K we spawn
 * one child process per K value.
 *
 *   node scripts/bench-hash-pool.mjs            (outer: sweeps K)
 *   NEARBYTES_HASH_BENCH_INNER=1 \
 *   NEARBYTES_HASH_POOL_CAPACITY=K \
 *     node scripts/bench-hash-pool.mjs          (inner: runs one K)
 *
 * Reads:
 *   NEARBYTES_HASH_BENCH_N        payloads per K (default 16)
 *   NEARBYTES_HASH_BENCH_BYTES    bytes per payload (default 32 MiB)
 *   NEARBYTES_HASH_BENCH_BATCH    bytes per update (default 4 MiB)
 *   NEARBYTES_HASH_BENCH_KS       comma-separated K values
 *                                 (default: 1, 2, 4, availableParallelism())
 *   NEARBYTES_HASH_BENCH_RUNS     repeats per K for median (default 5)
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const N = Number(process.env.NEARBYTES_HASH_BENCH_N ?? 16);
const BYTES = Number(process.env.NEARBYTES_HASH_BENCH_BYTES ?? 32 * 1024 * 1024);
const BATCH = Number(process.env.NEARBYTES_HASH_BENCH_BATCH ?? 4 * 1024 * 1024);
const RUNS = Number(process.env.NEARBYTES_HASH_BENCH_RUNS ?? 5);

function makePayload(seed) {
  const buf = Buffer.alloc(BYTES);
  for (let i = 0; i < BYTES; i++) buf[i] = (i + seed) & 0xff;
  return buf;
}

function referenceDigest(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function runInner() {
  const { acquireSha256Stream } = await import('nearbytes-crypto');
  const payloads = Array.from({ length: N }, (_, i) => makePayload(i + 1));
  const expected = payloads.map(referenceDigest);

  async function hashOne(payload) {
    const hasher = await acquireSha256Stream();
    for (let off = 0; off < payload.byteLength; off += BATCH) {
      const end = Math.min(off + BATCH, payload.byteLength);
      const slice = payload.subarray(off, end);
      const ab = new ArrayBuffer(slice.byteLength);
      new Uint8Array(ab).set(slice);
      hasher.updateTransfer(ab);
    }
    return hasher.finalize();
  }

  // Warm-up: trigger pool spawn + first message round-trip on each worker.
  const K = Math.max(1, Math.floor(Number(process.env.NEARBYTES_HASH_POOL_CAPACITY ?? availableParallelism())));
  await Promise.all(
    Array.from({ length: K }, async () => {
      const h = await acquireSha256Stream();
      h.updateTransfer(new ArrayBuffer(0));
      await h.finalize();
    }),
  );

  const results = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = process.hrtime.bigint();
    const digests = await Promise.all(payloads.map((p) => hashOne(p)));
    const t1 = process.hrtime.bigint();
    for (let i = 0; i < digests.length; i++) {
      if (digests[i] !== expected[i]) {
        throw new Error(`digest mismatch at ${i}`);
      }
    }
    results.push(Number(t1 - t0) / 1e6);
  }
  process.stdout.write(JSON.stringify({ K, results }) + '\n');
  // The pool's workers are .unref()-ed, so the process exits cleanly here.
}

function spawnInner(K) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF], {
      env: {
        ...process.env,
        NEARBYTES_HASH_BENCH_INNER: '1',
        NEARBYTES_HASH_POOL_CAPACITY: String(K),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`inner exited ${code}: ${out.slice(0, 300)}`));
      const last = out.trim().split('\n').filter(Boolean).at(-1) ?? '';
      try {
        resolve(JSON.parse(last));
      } catch (err) {
        reject(new Error(`bad inner output: ${last}`));
      }
    });
  });
}

async function runOuter() {
  const defaultKs = [1, 2, 4, Math.max(2, availableParallelism())];
  const KS = process.env.NEARBYTES_HASH_BENCH_KS
    ? process.env.NEARBYTES_HASH_BENCH_KS.split(',').map((s) => Number(s.trim())).filter((x) => Number.isFinite(x) && x > 0)
    : [...new Set(defaultKs)].sort((a, b) => a - b);
  const aggBytes = N * BYTES;

  console.log(
    `\nStreaming SHA-256 microbenchmark: N=${N} × ${(BYTES / (1 << 20)).toFixed(0)} MiB ` +
      `(batch ${(BATCH / (1 << 20)).toFixed(0)} MiB), runs=${RUNS}, host cores=${availableParallelism()}`,
  );
  console.log(`aggregate per K: ${(aggBytes / (1 << 20)).toFixed(0)} MiB; K sweep: ${KS.join(', ')}\n`);

  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const mbps = (b, ms) => (ms > 0 ? (b * 8) / ms / 1000 : 0);
  const fmtG = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} Gb/s` : `${m.toFixed(0)} Mb/s`);

  console.log(['K', 'median (ms)', 'min (ms)', 'max (ms)', 'goodput (med)'].map((c) => c.padEnd(14)).join(''));
  console.log('-'.repeat(70));

  let baselineMed = null;
  for (const K of KS) {
    const { results } = await spawnInner(K);
    const med = median(results);
    const lo = Math.min(...results);
    const hi = Math.max(...results);
    const g = mbps(aggBytes, med);
    const speedup = baselineMed !== null ? ` (${(baselineMed / med).toFixed(2)}× vs K=${KS[0]})` : '';
    if (baselineMed === null) baselineMed = med;
    console.log(
      [
        String(K).padEnd(14),
        med.toFixed(0).padEnd(14),
        lo.toFixed(0).padEnd(14),
        hi.toFixed(0).padEnd(14),
        `${fmtG(g)}${speedup}`,
      ].join(''),
    );
  }
  console.log('');
}

if (process.env.NEARBYTES_HASH_BENCH_INNER === '1') {
  runInner().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runOuter().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
