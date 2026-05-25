#!/usr/bin/env node
/**
 * HashWorkerPool microbenchmark.
 *
 * Streams N independent payloads of size S through the pool with varying
 * capacities K, and measures aggregate wall-clock hashing throughput. This
 * isolates the pool's CPU-side scaling from the sync wire/disk overhead and
 * is the upper bound on the parallel hash throughput the receiver can
 * achieve when K block streams finalize concurrently.
 *
 * Each "fetch" is simulated as: a buffer is split into 4 MiB batches, each
 * batch is `updateTransfer`-ed to the pool's streaming hasher, then
 * `finalize`-d. All N fetches are started concurrently via `Promise.all`,
 * so K of them progress in true parallel and the rest queue on pool waiters.
 *
 *   node scripts/bench-hash-pool.mjs
 *
 * Reads:
 *   NEARBYTES_HASH_BENCH_N        number of fetches per K (default 16)
 *   NEARBYTES_HASH_BENCH_BYTES    bytes per fetch (default 32 MiB)
 *   NEARBYTES_HASH_BENCH_BATCH    bytes per update batch (default 4 MiB)
 *   NEARBYTES_HASH_BENCH_KS       comma-separated K values to sweep
 *                                 (default: 1, 2, 4, availableParallelism())
 *   NEARBYTES_HASH_BENCH_RUNS     repeats per K for median (default 5)
 */

import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { createHashWorkerPool } from 'nearbytes-crypto';

const N = Number(process.env.NEARBYTES_HASH_BENCH_N ?? 16);
const BYTES = Number(process.env.NEARBYTES_HASH_BENCH_BYTES ?? 32 * 1024 * 1024);
const BATCH = Number(process.env.NEARBYTES_HASH_BENCH_BATCH ?? 4 * 1024 * 1024);
const RUNS = Number(process.env.NEARBYTES_HASH_BENCH_RUNS ?? 5);
const defaultKs = [1, 2, 4, Math.max(2, availableParallelism())];
const KS = process.env.NEARBYTES_HASH_BENCH_KS
  ? process.env.NEARBYTES_HASH_BENCH_KS.split(',').map((s) => Number(s.trim())).filter((x) => Number.isFinite(x) && x > 0)
  : [...new Set(defaultKs)].sort((a, b) => a - b);

function makePayload(seed) {
  const buf = Buffer.alloc(BYTES);
  for (let i = 0; i < BYTES; i++) buf[i] = (i + seed) & 0xff;
  return buf;
}

function referenceDigest(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function hashOne(pool, payload) {
  const hasher = await pool.acquire();
  for (let off = 0; off < payload.byteLength; off += BATCH) {
    const end = Math.min(off + BATCH, payload.byteLength);
    const slice = payload.subarray(off, end);
    const ab = new ArrayBuffer(slice.byteLength);
    new Uint8Array(ab).set(slice);
    hasher.updateTransfer(ab);
  }
  return hasher.finalize();
}

async function runOne(K, payloads, expected) {
  const pool = createHashWorkerPool({ capacity: K });
  // Warm-up: ensure all workers have processed one quick acquire
  await Promise.all(
    Array.from({ length: K }, async () => {
      const h = await pool.acquire();
      h.updateTransfer(new ArrayBuffer(0));
      await h.finalize();
    }),
  );
  const t0 = process.hrtime.bigint();
  const digests = await Promise.all(payloads.map((p) => hashOne(pool, p)));
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < digests.length; i++) {
    if (digests[i] !== expected[i]) {
      throw new Error(`digest mismatch at ${i}: got ${digests[i].slice(0, 16)} expected ${expected[i].slice(0, 16)}`);
    }
  }
  await pool.close();
  const wallMs = Number(t1 - t0) / 1e6;
  return wallMs;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function mbps(bytes, ms) {
  return ms > 0 ? (bytes * 8) / ms / 1000 : 0;
}

function fmtG(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} Gb/s` : `${m.toFixed(0)} Mb/s`;
}

(async () => {
  console.log(
    `\nHashWorkerPool microbenchmark: N=${N} payloads × ${(BYTES / (1 << 20)).toFixed(0)} MiB ` +
      `(batch ${(BATCH / (1 << 20)).toFixed(0)} MiB), runs=${RUNS}, host cores=${availableParallelism()}`,
  );
  const aggBytes = N * BYTES;
  console.log(`aggregate per K: ${(aggBytes / (1 << 20)).toFixed(0)} MiB`);
  console.log(`K sweep: ${KS.join(', ')}\n`);

  const payloads = Array.from({ length: N }, (_, i) => makePayload(i + 1));
  const expected = payloads.map(referenceDigest);

  const cols = ['K', 'median (ms)', 'min (ms)', 'max (ms)', 'goodput (med)'];
  console.log(cols.map((c) => c.padEnd(14)).join(''));
  console.log('-'.repeat(70));

  const baseline = { medMs: null };
  for (const K of KS) {
    const ms = [];
    for (let r = 0; r < RUNS; r++) {
      const t = await runOne(K, payloads, expected);
      ms.push(t);
    }
    const med = median(ms);
    const lo = Math.min(...ms);
    const hi = Math.max(...ms);
    const g = mbps(aggBytes, med);
    const speedup = baseline.medMs !== null ? ` (${(baseline.medMs / med).toFixed(2)}× vs K=${KS[0]})` : '';
    if (baseline.medMs === null) baseline.medMs = med;
    const row = [
      String(K).padEnd(14),
      `${med.toFixed(0)}`.padEnd(14),
      `${lo.toFixed(0)}`.padEnd(14),
      `${hi.toFixed(0)}`.padEnd(14),
      `${fmtG(g)}${speedup}`,
    ];
    console.log(row.join(''));
  }
  console.log('');
})();
