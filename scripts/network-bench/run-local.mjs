#!/usr/bin/env node
/**
 * Local-category network benchmark.
 *
 *   yarn bench:network:local              # full sweep (~60s on Apple Silicon)
 *   yarn bench:network:local --out path   # custom JSON destination
 *
 * For each size class (small, large, burst) we run K measured repeats of:
 *   - nc      (raw TCP loopback, server writes to disk)
 *   - cat     (byte-for-byte copy; avoids APFS clonefile)
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
import { shouldTakeAnotherNetworkRep } from '../lib/bench-timing.mjs';
import { writeDeterministicPayload } from './lib/payload.mjs';
import {
  localNc, localCat, mkScratch, cleanScratch,
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
function fmtGbps(m) {
  if (!Number.isFinite(m) || m <= 0) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} Gb/s` : `${Math.round(m)} Mb/s`;
}
function decomposeNearbytesRun(m) {
  const streams = (m.perStream ?? []).flat().filter(Boolean);
  const publishMs = m.publishWallMs ?? 0;
  // Single block: receiver marker. Many concurrent blocks: aggregate window.
  const wireMs =
    streams.length === 1
      ? (streams[0].wireMs ?? 0)
      : streams.length > 1
        ? Math.max(0, m.wallMs - publishMs)
        : 0;
  const xferMs = Math.max(wireMs, m.wallMs - publishMs);
  return {
    e2eMbps: mbps(m.bytes, m.wallMs),
    publishMbps: publishMs > 0 ? mbps(m.bytes, publishMs) : 0,
    wireMbps: wireMs > 0 ? mbps(m.bytes, wireMs) : 0,
    xferMbps: xferMs > 0 ? mbps(m.bytes, xferMs) : 0,
    publishMs,
    wireMs,
    xferMs,
  };
}
function printSummary(report) {
  const host = report.machines?.local;
  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  Nearbytes network-bench — local goodput (p50, measured repeats)         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  if (host) {
    console.log(`  ${host.cpuModel} · ${host.cpuLogicalCores} cores · ${host.osName} ${host.osVersion}`);
  }
  console.log(
    `  friend session (one-time): alice ${report.friendSessionMs?.alice ?? '?'} ms · bob ${report.friendSessionMs?.bob ?? '?'} ms\n`,
  );
  const hdr =
    '  Class          │ nc/cat (E2E)     │ nearbytes E2E    │ publish (alice)  │ wire (bob)       │ xfer after pub';
  console.log(hdr);
  console.log('  ' + '─'.repeat(hdr.length - 2));
  for (const sc of report.sizeClasses) {
    const label = `${sc.sizeClass} (${describeSize(report.plans[sc.sizeClass])})`.padEnd(14);
    const nc = sc.systems.nc?.goodputMbps?.p50;
    const cat = sc.systems.cat?.goodputMbps?.p50;
    const nb = sc.systems.nearbytes;
    const runs = nb?.runs ?? [];
    const pub = runs.map((r) => r.publishWallMs).filter(Number.isFinite);
    const wires = runs.map((r) => r.wireMs).filter(Number.isFinite);
    const e2e = nb?.goodputMbps?.p50;
    const pubP50 = quantiles(pub)?.p50;
    const wireP50 = quantiles(wires)?.p50;
    const xferRuns = runs.map((r) => decomposeNearbytesRun({ ...r, bytes: sc.aggregateBytes, perStream: r.perStream }));
    const xferP50 = quantiles(xferRuns.map((d) => d.xferMbps))?.p50;
    const pubMbpsP50 = quantiles(xferRuns.map((d) => d.publishMbps))?.p50;
    const wireMbpsP50 = quantiles(xferRuns.map((d) => d.wireMbps))?.p50;
    console.log(
      `  ${label} │ nc ${fmtGbps(nc).padStart(8)} │ cat ${fmtGbps(cat).padStart(8)} │ ` +
        `E2E ${fmtGbps(e2e).padStart(8)} │ ${fmtGbps(pubMbpsP50).padStart(8)} (${fmtMs(pubP50).padStart(5)}) │ ` +
        `${fmtGbps(wireMbpsP50).padStart(8)} (${fmtMs(wireP50).padStart(5)}) │ ${fmtGbps(xferP50).padStart(8)}`,
    );
  }
  console.log(
    '\n  E2E = bob expect → last block stored. publish = alice addFile (encrypt+hash+journal).',
  );
  console.log('  wire = receiver bulk-recv first→last byte. xfer = E2E − publish (sync path).\n');
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
  const bytes = totalBytes(plan);
  const deco = decomposeNearbytesRun({ wallMs: r.wallMs, bytes, perStream: r.perStream, publishWallMs: r.publishWallMs });
  return {
    wallMs: r.wallMs,
    bytes,
    count: plan.count,
    perStream: r.perStream,
    publishWallMs: r.publishWallMs,
    wireMs: deco.wireMs,
    ...deco,
  };
}

async function runSizeClass({ pair, sizeClass, plan, scratchBase, repeats }) {
  console.log(`\n── ${sizeClass} (${describeSize(plan)}) ──`);
  const systems = sizeClass === 'small'
    ? ['nc', 'cat', 'nearbytes']
    : ['nc', 'cat', 'nearbytes'];
  const results = { nc: [], cat: [], nearbytes: [] };
  const perStreamAll = [];

  let totalMeasuredMs = 0;
  let measured = 0;
  for (let rep = 0; rep < repeats.warmup + repeats.measured; rep++) {
    const isWarmup = rep < repeats.warmup;
    if (!isWarmup && measured >= repeats.measured) break;
    if (!isWarmup && measured > 0 && !shouldTakeAnotherNetworkRep({ totalMeasuredMs })) break;
    const tag = isWarmup
      ? `warmup ${rep + 1}/${repeats.warmup}`
      : `measured ${measured + 1}/${repeats.measured}`;
    const scratch = `${scratchBase}-${rep}`;
    await mkdir(scratch, { recursive: true });
    const files = buildFiles(plan, scratch, sizeClass);
    let line = `  ${tag.padEnd(14)} `;
    let repWallMs = 0;
    for (const sys of systems) {
      try {
        const m =
          sys === 'nc' ? { wallMs: (await localNc(files, scratch)).wallMs, bytes: totalBytes(plan) }
          : sys === 'cat' ? { wallMs: (await localCat(files, scratch)).wallMs, bytes: totalBytes(plan) }
          : await runOneNearbytes(pair, plan, sizeClass === 'burst');
        repWallMs = Math.max(repWallMs, m.wallMs);
        if (!isWarmup) {
          const row = { wallMs: m.wallMs, goodputMbps: mbps(m.bytes, m.wallMs) };
          if (sys === 'nearbytes') {
            row.publishWallMs = m.publishWallMs;
            row.wireMs = m.wireMs;
            row.e2eMbps = m.e2eMbps;
            row.publishMbps = m.publishMbps;
            row.wireMbps = m.wireMbps;
            row.xferMbps = m.xferMbps;
            row.perStream = m.perStream;
            perStreamAll.push(m.perStream);
          }
          results[sys].push(row);
        }
        const rate = sys === 'nearbytes' ? fmtGbps(m.e2eMbps ?? mbps(m.bytes, m.wallMs)) : fmtGbps(mbps(m.bytes, m.wallMs));
        line += `${sys}=${fmtMs(m.wallMs).padStart(8)} (${rate.padStart(9)})  `;
      } catch (err) {
        line += `${sys}=FAIL  `;
        console.error(`    ${sys} failed: ${err.message}`);
      }
    }
    if (!isWarmup) {
      measured++;
      totalMeasuredMs += repWallMs;
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
  printSummary(report);
  console.log(`wrote ${OUT_PATH} (${report.wallSeconds}s wall)`);
  cleanScratch(scratchBase);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
