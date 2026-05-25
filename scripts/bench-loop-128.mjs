#!/usr/bin/env node
/**
 * Run the 128 MiB localhost sync benchmark N times and aggregate phase timings.
 *
 *   node scripts/bench-loop-128.mjs [N=10]
 *
 * Reads `bulk-recv-phases` markers from each receiver activity log and prints
 * min/median/mean/max for wire/drain/hash/total.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const N = Number(process.argv[2] ?? 10);
const SIZE = Number(process.env.NEARBYTES_BENCH_SIZE ?? 134217728);
const RUN_TIMEOUT_MS = Number(process.env.NEARBYTES_BENCH_RUN_TIMEOUT_MS ?? 45000);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const runs = [];

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
    NEARBYTES_BENCH_PROFILE: 'paper',
    NEARBYTES_BENCH_LATENCY_REPEATS: '0',
    NEARBYTES_BENCH_LATENCY_WARMUP: '0',
    NEARBYTES_BENCH_STREAM_SIZES: String(SIZE),
    NEARBYTES_BENCH_DISCOVERY_MS: '2000',
    NEARBYTES_BENCH_GRACE_MS: '3000',
    NEARBYTES_BENCH_ROLE: role,
    NEARBYTES_BENCH_OUT: outPath,
  };
  const child = spawn(process.execPath, [join(ROOT, 'dist/sync-benchmark.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
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
    .split('\n').filter((l) => l.includes('bench {'))
    .map((l) => JSON.parse(l.split('bench ', 2)[1]));
}

async function once(i) {
  const base = join(ROOT, '.local', `loop-${i}`);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(join(base, 'paper'), { recursive: true });
  await killStale();
  const bobOut = join(base, 'paper/bob/benchmark-result.json');
  const aliceOut = join(base, 'paper/alice/benchmark-result.json');
  const bob = spawnBench('receiver', join(base, 'paper'), bobOut);
  await new Promise((r) => setTimeout(r, 600));
  const alice = spawnBench('sender', join(base, 'paper'), aliceOut);

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (alice.getStdout().includes('done — wrote') || bob.getStdout().includes('done — wrote')) {
      break;
    }
    if (alice.child.exitCode !== null && alice.child.exitCode !== 0) {
      try { bob.child.kill(); } catch {}
      throw new Error(`run ${i} alice exited ${alice.child.exitCode}: ${alice.getStderr().slice(0, 200)}`);
    }
    if (bob.child.exitCode !== null && bob.child.exitCode !== 0) {
      try { alice.child.kill(); } catch {}
      throw new Error(`run ${i} bob exited ${bob.child.exitCode}: ${bob.getStderr().slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  try { bob.child.kill(); } catch {}
  try { alice.child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 200));

  const aliceEv = parseActivity(join(base, 'paper/alice/data/sync/activity.log'));
  const bobEv = parseActivity(join(base, 'paper/bob/data/sync/activity.log'));
  const send = aliceEv.find((e) => e.bench === 'bulk-send-phases' && (e.bytes ?? 0) >= SIZE * 0.95);
  const recv = bobEv.find((e) => e.bench === 'bulk-recv-phases' && (e.bytes ?? 0) >= SIZE * 0.95);
  const pub = [...aliceEv].reverse().find((e) => e.bench === 'file-published' && (e.sizeBytes ?? 0) >= SIZE * 0.95);
  const inb = bobEv.find((e) => e.bench === 'inbound-stored' && (e.bytes ?? 0) >= SIZE * 0.95);
  if (!recv) {
    throw new Error(
      `run ${i}: no bulk-recv-phases (alice events ${aliceEv.length}, bob events ${bobEv.length})\nbob err: ${bob.getStderr().slice(0, 200)}`,
    );
  }
  const wire = recv.lastByteAt - recv.firstByteAt;
  const drain = (recv.diskDrainDoneAt ?? recv.lastByteAt) - recv.lastByteAt;
  const hash = recv.hashDoneAt - (recv.diskDrainDoneAt ?? recv.lastByteAt);
  const rename = recv.renameDoneAt - recv.hashDoneAt;
  // Use renameDoneAt for total to exclude reception/marker log write overhead from the critical path
  const total = pub ? recv.renameDoneAt - pub.t : null;
  const totalIncludingLog = pub && inb ? inb.t - pub.t : null;
  const pump = send ? send.pumpEndAt - send.pumpBeginAt : null;
  return { i, wire, drain, hash, rename, total, totalIncludingLog, pump, bytes: recv.bytes };
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

function mbps(bytes, ms) {
  return ms > 0 ? ((bytes * 8) / ms / 1000) : 0;
}

function fmtTime(s) { return s == null ? 'n/a' : `${s.toFixed(0)} ms`; }
function fmtMbps(s, bytes) {
  if (s == null || s <= 0) return '';
  const m = mbps(bytes, s);
  return m >= 1000 ? `${(m / 1000).toFixed(2)} Gb/s` : `${m.toFixed(0)} Mb/s`;
}

(async () => {
  const sizeLabel = SIZE >= 1 << 30 ? `${(SIZE / (1 << 30)).toFixed(2)} GiB` : `${(SIZE / (1 << 20)).toFixed(0)} MiB`;
  console.log(`Running ${N} iterations of ${sizeLabel} sync localhost (timeout ${RUN_TIMEOUT_MS}ms)...\n`);
  for (let i = 1; i <= N; i++) {
    try {
      const r = await once(i);
      runs.push(r);
      process.stdout.write(
        `run ${String(i).padStart(2)}/${N}: pump=${r.pump}ms wire=${r.wire}ms drain=${r.drain}ms hash=${r.hash}ms rename=${r.rename}ms total=${r.total}ms\n`,
      );
    } catch (e) {
      console.error(`run ${i} failed:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  killStale();

  const bytes = SIZE;
  const cols = [
    ['SEND pump', 'pump'],
    ['RECV wire (1st→last byte)', 'wire'],
    ['RECV disk drain (async)', 'drain'],
    ['RECV hash verify', 'hash'],
    ['RECV rename', 'rename'],
    ['TOTAL publish→rename', 'total'],
    ['TOTAL publish→inbound (+log)', 'totalIncludingLog'],
  ];
  console.log('\n=== aggregate over %d runs ===', runs.length);
  console.log('%s   %s %s %s %s %s', 'phase'.padEnd(28), 'min'.padStart(9), 'med'.padStart(9), 'mean'.padStart(10), 'max'.padStart(9), 'median Mb/s'.padStart(14));
  for (const [label, key] of cols) {
    const s = stats(runs.map((r) => r[key]));
    if (!s) continue;
    console.log('%s   %s %s %s %s %s',
      label.padEnd(28),
      fmtTime(s.min).padStart(9),
      fmtTime(s.median).padStart(9),
      fmtTime(s.mean).padStart(10),
      fmtTime(s.max).padStart(9),
      fmtMbps(s.median, bytes).padStart(14),
    );
  }
  console.log('');
})();
