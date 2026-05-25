#!/usr/bin/env node
/**
 * K-parallel-fetch benchmark.
 *
 * Drives the bidirectional `sync-benchmark.js` harness in burst-publish mode
 * so the sender pushes K independent block streams back-to-back on a single
 * association and the receiver hashes them concurrently via the
 * `HashWorkerPool` in `nearbytes-crypto`.
 *
 * Usage:
 *   node scripts/bench-parallel-fetch.mjs [N=5]
 *
 * Reads:
 *   NEARBYTES_BENCH_PFETCH_SIZES   comma-separated bytes per stream (default
 *                                  16 MiB × 8 = 128 MiB aggregate)
 *   NEARBYTES_BENCH_PFETCH_POOL    hashWorkerPoolCapacity passed to sync (1..N)
 *   NEARBYTES_BENCH_PFETCH_TIMEOUT per-run timeout in ms (default 60s)
 *
 * Prints per-run timings (per-stream wire/drain/hash + aggregate wall) and
 * aggregate stats over N runs. Compare K=1 (single hash worker) against
 * K=availableParallelism() to observe the K-fold reduction in wall time.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const N = Number(process.argv[2] ?? 5);
const RUN_TIMEOUT_MS = Number(process.env.NEARBYTES_BENCH_PFETCH_TIMEOUT ?? 60_000);
const DEFAULT_SIZES = Array.from({ length: 8 }, () => 16 * 1024 * 1024).join(',');
const SIZES_ENV = process.env.NEARBYTES_BENCH_PFETCH_SIZES ?? DEFAULT_SIZES;
const SIZES = SIZES_ENV.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const HASH_POOL = process.env.NEARBYTES_BENCH_PFETCH_POOL
  ? Number(process.env.NEARBYTES_BENCH_PFETCH_POOL)
  : Math.max(2, availableParallelism());
const AGG_BYTES = SIZES.reduce((a, b) => a + b, 0);

async function killStale() {
  await new Promise((resolve) => {
    const p = spawn('pkill', ['-f', 'dist/sync-benchmark.js'], { stdio: 'ignore' });
    p.on('exit', resolve);
    p.on('error', resolve);
  });
  await new Promise((r) => setTimeout(r, 400));
}

function spawnBench(role, base, outPath) {
  const env = {
    ...process.env,
    NEARBYTES_SYNC_DISCOVERY: 'mdns',
    NEARBYTES_BENCH_BASE: base,
    NEARBYTES_BENCH_PROFILE: 'campaign',
    NEARBYTES_BENCH_LATENCY_REPEATS: '0',
    NEARBYTES_BENCH_LATENCY_WARMUP: '0',
    NEARBYTES_BENCH_STREAM_SIZES: SIZES.join(','),
    NEARBYTES_BENCH_STREAM_INTER_MS: '0',
    NEARBYTES_BENCH_DISCOVERY_MS: '2000',
    NEARBYTES_BENCH_GRACE_MS: '3000',
    NEARBYTES_BENCH_ROLE: role,
    NEARBYTES_BENCH_OUT: outPath,
    NEARBYTES_BENCH_BURST_PUBLISH: 'true',
    NEARBYTES_HASH_POOL_CAPACITY: String(HASH_POOL),
  };
  const child = spawn(process.execPath, [join(ROOT, 'dist/sync-benchmark.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c.toString()));
  child.stderr.on('data', (c) => (stderr += c.toString()));
  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

function parseActivity(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.includes('bench {'))
    .map((l) => JSON.parse(l.split('bench ', 2)[1]));
}

async function once(i) {
  const base = join(ROOT, '.local', `pfetch-${i}`);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(join(base, 'campaign'), { recursive: true });
  await killStale();
  const bobOut = join(base, 'campaign/bob/benchmark-result.json');
  const aliceOut = join(base, 'campaign/alice/benchmark-result.json');
  const bob = spawnBench('receiver', join(base, 'campaign'), bobOut);
  await new Promise((r) => setTimeout(r, 600));
  const alice = spawnBench('sender', join(base, 'campaign'), aliceOut);

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (alice.getStdout().includes('done — wrote') && bob.getStdout().includes('done — wrote')) {
      break;
    }
    if (alice.child.exitCode !== null && alice.child.exitCode !== 0) {
      try { bob.child.kill(); } catch {}
      throw new Error(`run ${i} alice exited ${alice.child.exitCode}: ${alice.getStderr().slice(0, 300)}`);
    }
    if (bob.child.exitCode !== null && bob.child.exitCode !== 0) {
      try { alice.child.kill(); } catch {}
      throw new Error(`run ${i} bob exited ${bob.child.exitCode}: ${bob.getStderr().slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));
  try { bob.child.kill(); } catch {}
  try { alice.child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 200));

  const aliceEv = parseActivity(join(base, 'campaign/alice/data/sync/activity.log'));
  const bobEv = parseActivity(join(base, 'campaign/bob/data/sync/activity.log'));

  const burstStart = aliceEv.find((e) => e.bench === 'burst-phase-start');
  const recvPhases = bobEv.filter((e) => e.bench === 'bulk-recv-phases');
  const matched = [];
  const used = new Set();
  for (const sz of SIZES) {
    let idx = -1;
    for (let i = 0; i < recvPhases.length; i++) {
      if (used.has(i)) continue;
      const b = recvPhases[i].bytes ?? 0;
      if (b >= sz * 0.95 && b <= sz * 1.05) { idx = i; break; }
    }
    if (idx >= 0) {
      used.add(idx);
      matched.push(recvPhases[idx]);
    }
  }
  if (matched.length === 0) {
    throw new Error(
      `run ${i}: no bulk-recv-phases (alice ${aliceEv.length}, bob ${bobEv.length})\nbob err: ${bob.getStderr().slice(0, 300)}`,
    );
  }

  const firstByte = matched.reduce((m, e) => Math.min(m, e.firstByteAt), Infinity);
  const lastRename = matched.reduce((m, e) => Math.max(m, e.renameDoneAt), 0);
  const wallMs = lastRename - firstByte;
  const perStream = matched.map((e) => ({
    bytes: e.bytes,
    wireMs: e.lastByteAt - e.firstByteAt,
    drainMs: (e.diskDrainDoneAt ?? e.lastByteAt) - e.lastByteAt,
    hashMs: e.hashDoneAt - (e.diskDrainDoneAt ?? e.lastByteAt),
    renameMs: e.renameDoneAt - e.hashDoneAt,
  }));
  return {
    i,
    aggBytes: matched.reduce((a, e) => a + e.bytes, 0),
    matched: matched.length,
    wallMs,
    burstStartAt: burstStart?.t ?? null,
    perStream,
  };
}

function mbps(bytes, ms) {
  return ms > 0 ? (bytes * 8) / ms / 1000 : 0;
}

function fmtMbps(b, ms) {
  const m = mbps(b, ms);
  return m >= 1000 ? `${(m / 1000).toFixed(2)} Gb/s` : `${m.toFixed(0)} Mb/s`;
}

function stats(arr) {
  const xs = arr.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    n: xs.length,
    min: xs[0],
    max: xs[xs.length - 1],
    median: xs[Math.floor(xs.length / 2)],
    mean: sum / xs.length,
  };
}

(async () => {
  console.log(
    `\nK-parallel-fetch benchmark: ${SIZES.length} streams, sizes [${SIZES.map((s) => (s / (1 << 20)).toFixed(0) + ' MiB').join(', ')}]`,
  );
  console.log(`hash worker pool capacity: ${HASH_POOL}, aggregate ${(AGG_BYTES / (1 << 20)).toFixed(0)} MiB`);
  console.log(`runs: ${N}, per-run timeout: ${RUN_TIMEOUT_MS} ms\n`);

  const runs = [];
  for (let i = 1; i <= N; i++) {
    try {
      const r = await once(i);
      runs.push(r);
      const agg = fmtMbps(r.aggBytes, r.wallMs);
      const perStr = r.perStream
        .map((s) => `${(s.bytes / (1 << 20)).toFixed(0)}MiB wire=${s.wireMs}ms hash=${s.hashMs}ms`)
        .join(' | ');
      console.log(
        `run ${String(i).padStart(2)}/${N}: matched=${r.matched}/${SIZES.length}, wall=${r.wallMs}ms (agg ${agg})\n          ${perStr}`,
      );
    } catch (e) {
      console.error(`run ${i} failed:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await killStale();

  const wallStats = stats(runs.map((r) => r.wallMs));
  const aggStats = stats(runs.map((r) => mbps(r.aggBytes, r.wallMs) * 1000)); // Mb/s × 1000 trick? no, just Mb/s

  console.log(`\n=== aggregate over ${runs.length} successful runs ===`);
  if (wallStats) {
    console.log(
      `wall (first byte → last rename): min ${wallStats.min}ms, med ${wallStats.median}ms, mean ${wallStats.mean.toFixed(0)}ms, max ${wallStats.max}ms`,
    );
  }
  if (aggStats) {
    const medGoodput = mbps(AGG_BYTES, wallStats.median);
    const meanGoodput = mbps(AGG_BYTES, wallStats.mean);
    const fmtG = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} Gb/s` : `${m.toFixed(0)} Mb/s`);
    console.log(`aggregate goodput (median): ${fmtG(medGoodput)}`);
    console.log(`aggregate goodput (mean):   ${fmtG(meanGoodput)}`);
  }
  console.log('');
})();
