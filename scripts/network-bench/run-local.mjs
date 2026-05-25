#!/usr/bin/env node
/**
 * Local-category network benchmark.
 *
 *   yarn bench:network:local              # full sweep (~60s on Apple Silicon)
 *   yarn bench:network:local --out path   # custom JSON destination
 *
 * For each size class (small, large, burst) we run K measured repeats of:
 *   - nc      (raw TCP loopback, server writes to disk)
 *   - cp      (filesystem copy on the same FS)
 *   - nearbytes  (end-to-end sync, encrypt + hash + journal + store)
 *
 * One discarded warmup run per system primes page cache + V8. The
 * nearbytes pair is spawned ONCE for the whole sweep, so we pay the
 * friend-session handshake cost just once and each measurement is the
 * actual data path.
 *
 * Output: JSON at `.local/bench/network/local-results.json` with the
 * shape consumed by the paper figure builder.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { collectLocalHostInfo } from './lib/hostinfo.mjs';
import { SIZES, REPEATS, describeSize, totalBytes, formatBytes } from './lib/sizes.mjs';
import { writeDeterministicPayload } from './lib/payload.mjs';
import {
  localNc, localCp, mkScratch, cleanScratch,
} from './lib/baselines.mjs';
import { NearbytesPair, ensurePeerBuilt } from './lib/nearbytes-pair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT_PATH = arg('--out', join(REPO_ROOT, '.local/bench/network/local-results.json'));

function fmtMs(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
function mbps(bytes, ms) {
  return ms > 0 ? Number(((bytes * 8) / ms / 1000).toFixed(1)) : 0;
}
function quantiles(xs) {
  const v = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
  return {
    n: v.length,
    min: v[0],
    p50: q(50),
    p95: q(95),
    max: v[v.length - 1],
    mean: v.reduce((a, b) => a + b, 0) / v.length,
  };
}

function buildFiles(plan, scratch, sizeClassName) {
  const out = [];
  for (let i = 0; i < plan.count; i++) {
    const name = `${sizeClassName}-${i}`;
    const path = join(scratch, `${name}.bin`);
    writeDeterministicPayload(path, plan.bytes, i + 1);
    out.push({ name, path, bytes: plan.bytes });
  }
  return out;
}

async function runOneNearbytes(pair, plan, burst) {
  const files = Array.from({ length: plan.count }, () => ({ bytes: plan.bytes }));
  const r = await pair.measure({ files, burst, timeoutMs: 30_000 });
  return {
    wallMs: r.wallMs,
    bytes: totalBytes(plan),
    count: plan.count,
    perStream: r.perStream,
    publishWallMs: r.publishWallMs,
  };
}

async function runSizeClass({ pair, sizeClass, plan, scratchBase, repeats }) {
  console.log(`\n── ${sizeClass} (${describeSize(plan)}) ──`);
  const systems = sizeClass === 'small'
    ? ['nc', 'cp', 'nearbytes']
    : ['nc', 'cp', 'nearbytes'];
  const results = { nc: [], cp: [], nearbytes: [] };
  const perStreamAll = [];

  for (let rep = 0; rep < repeats.warmup + repeats.measured; rep++) {
    const isWarmup = rep < repeats.warmup;
    const tag = isWarmup
      ? `warmup ${rep + 1}/${repeats.warmup}`
      : `measured ${rep - repeats.warmup + 1}/${repeats.measured}`;
    const scratch = `${scratchBase}-${rep}`;
    await mkdir(scratch, { recursive: true });
    const files = buildFiles(plan, scratch, sizeClass);
    let line = `  ${tag.padEnd(14)} `;
    for (const sys of systems) {
      try {
        const m =
          sys === 'nc' ? { wallMs: (await localNc(files, scratch)).wallMs, bytes: totalBytes(plan) }
          : sys === 'cp' ? { wallMs: (await localCp(files, scratch)).wallMs, bytes: totalBytes(plan) }
          : await runOneNearbytes(pair, plan, sizeClass === 'burst');
        if (!isWarmup) {
          results[sys].push({ wallMs: m.wallMs, goodputMbps: mbps(m.bytes, m.wallMs) });
          if (sys === 'nearbytes' && m.perStream) perStreamAll.push(m.perStream);
        }
        line += `${sys}=${fmtMs(m.wallMs).padStart(8)} (${String(mbps(m.bytes, m.wallMs)).padStart(7)} Mb/s)  `;
      } catch (err) {
        line += `${sys}=FAIL  `;
        console.error(`    ${sys} failed: ${err.message}`);
      }
    }
    console.log(line);
    cleanScratch(scratch);
  }

  return {
    sizeClass,
    sizeBytes: plan.bytes,
    count: plan.count,
    aggregateBytes: totalBytes(plan),
    systems: Object.fromEntries(
      Object.entries(results).map(([k, runs]) => [
        k,
        {
          runs,
          wallMs: quantiles(runs.map((r) => r.wallMs)),
          goodputMbps: quantiles(runs.map((r) => r.goodputMbps)),
          perStream: k === 'nearbytes' ? perStreamAll : undefined,
        },
      ]),
    ),
  };
}

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(2);
});

async function main() {
  console.log(`network-bench / category=local (pid=${process.pid})\n`);
  await ensurePeerBuilt();

  const host = await collectLocalHostInfo();
  console.log(
    `host: ${host.osName} ${host.osVersion} (${host.kernel}) ${host.cpuModel} ` +
      `${host.cpuPhysicalCores}p/${host.cpuLogicalCores}l, ${host.memTotalGiB} GiB`,
  );

  const t0 = Date.now();
  const scratchBase = mkScratch();
  const repeats = REPEATS.local;
  const plans = SIZES.local;
  const peerBase = join(REPO_ROOT, '.local/bench/network/local-peer');

  console.log('\nstarting nearbytes pair (alice + bob)…');
  const pair = await NearbytesPair.startLocal(peerBase);
  console.log(
    `pair ready: friend session alice=${pair.friendMs.alice}ms bob=${pair.friendMs.bob}ms`,
  );

  let sizeClasses;
  try {
    const onlyClasses = (process.env.NEARBYTES_NETBENCH_CLASSES || 'small,large,burst').split(',');
    sizeClasses = [];
    for (const sizeClass of onlyClasses) {
      const out = await runSizeClass({
        pair,
        sizeClass,
        plan: plans[sizeClass],
        scratchBase: join(scratchBase, sizeClass),
        repeats,
      });
      sizeClasses.push(out);
    }
  } finally {
    await pair.stop();
  }

  const report = {
    category: 'local',
    generatedAt: new Date().toISOString(),
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    machines: { local: host },
    friendSessionMs: pair.friendMs,
    repeats,
    plans,
    sizeClasses,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${OUT_PATH} (${report.wallSeconds}s wall)`);
  cleanScratch(scratchBase);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
