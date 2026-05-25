#!/usr/bin/env node
/**
 * Aggregate K independent bench-report.json (one per campaign seed) into bench-campaign-report.json.
 *
 *   node scripts/aggregate-campaign.mjs --indir .local/bench/campaign/run-id --out report.json
 */

import { readFile, mkdir, readdir } from 'fs/promises';
import { writeBenchReport } from './bench-json.mjs';
import { printBenchReport } from './bench-report-print.mjs';
import path from 'path';
import {
  stats,
  bootstrapCi95,
  sizeLabel,
  isWarmupTrialName,
} from './benchmark-stats.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function loadJson(p) {
  return JSON.parse(await readFile(p, 'utf-8'));
}

const inDir = arg('--indir', '');
const outPath = arg('--out', path.join(inDir, 'bench-campaign-report.json'));
const topology = arg('--topology', 'localhost campaign');
const minValidTrials = Number(
  arg('--min-valid-trials', process.env['NEARBYTES_BENCH_MIN_VALID_TRIALS'] ?? '20'),
);

if (!inDir) {
  console.error('Need --indir with seed-*/bench-report.json');
  process.exit(1);
}

const entries = await readdir(inDir, { withFileTypes: true });
const seedDirs = entries
  .filter((e) => e.isDirectory() && e.name.startsWith('seed-'))
  .map((e) => e.name)
  .sort();

const MAX_LATENCY_MS = 10_000;

function seedLatencyTrialCount(report) {
  return (report.mergedTrials ?? []).filter(
    (t) =>
      !isWarmupTrialName(t.name) &&
      t.oneWayLatencyMs != null &&
      t.oneWayLatencyMs >= 0 &&
      t.oneWayLatencyMs <= MAX_LATENCY_MS,
  ).length;
}

const reports = [];
for (const sd of seedDirs) {
  const p = path.join(inDir, sd, 'bench-report.json');
  try {
    const report = await loadJson(p);
    const validTrials = seedLatencyTrialCount(report);
    if (validTrials < minValidTrials) {
      console.warn(
        `skip ${sd}: only ${validTrials} valid latency trials (need ${minValidTrials}+)`,
      );
      continue;
    }
    reports.push({ seed: sd, report });
  } catch {
    console.warn(`skip ${p}`);
  }
}

if (reports.length === 0) {
  console.error('No bench-report.json under seed-* directories');
  process.exit(1);
}

const latencyBySize = new Map();
const goodputBySize = new Map();
const streamPublishCpuBySize = new Map();
const publishCpuBySize = new Map();
const publishCpuLatencyBySize = new Map();
const syncTransferBySize = new Map();
const friendSessionSender = [];
const friendSessionReceiver = [];

for (const { report } of reports) {
  if (report.swarmFormation?.senderMs != null) friendSessionSender.push(report.swarmFormation.senderMs);
  if (report.swarmFormation?.receiverMs != null) friendSessionReceiver.push(report.swarmFormation.receiverMs);

  const latTrials = (report.mergedTrials ?? []).filter((t) => !isWarmupTrialName(t.name));

  for (const t of latTrials) {
    const v = t.oneWayLatencyMs;
    if (v == null || v < 0 || v > 10_000) continue;
    if (!latencyBySize.has(t.sizeBytes)) latencyBySize.set(t.sizeBytes, []);
    latencyBySize.get(t.sizeBytes).push(v);
    if (t.publishCpuMs != null && t.publishCpuMs >= 0) {
      if (!publishCpuLatencyBySize.has(t.sizeBytes)) publishCpuLatencyBySize.set(t.sizeBytes, []);
      publishCpuLatencyBySize.get(t.sizeBytes).push(t.publishCpuMs);
    }
    if (t.syncTransferMs != null && t.syncTransferMs >= 0) {
      if (!syncTransferBySize.has(t.sizeBytes)) syncTransferBySize.set(t.sizeBytes, []);
      syncTransferBySize.get(t.sizeBytes).push(t.syncTransferMs);
    }
  }

  for (const row of report.goodputTable ?? report.throughput?.streams ?? []) {
    const g = row.goodputMbps;
    if (g == null || !Number.isFinite(g)) continue;
    const sz = row.sizeBytes;
    if (!goodputBySize.has(sz)) goodputBySize.set(sz, []);
    goodputBySize.get(sz).push(g);
    if (row.publishCpuMs != null && row.publishCpuMs >= 0) {
      if (!streamPublishCpuBySize.has(sz)) streamPublishCpuBySize.set(sz, []);
      streamPublishCpuBySize.get(sz).push(row.publishCpuMs);
    }
  }

  for (const row of report.publishCpuTable ?? []) {
    if (row.mean == null) continue;
    if (!publishCpuBySize.has(row.sizeBytes)) publishCpuBySize.set(row.sizeBytes, []);
    publishCpuBySize.get(row.sizeBytes).push(row.mean);
  }
}

const latencyTable = [...latencyBySize.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([sizeBytes, values]) => ({
    sizeBytes,
    sizeLabel: sizeLabel(sizeBytes),
    ...stats(values),
    ciMethod: 'student-t-on-pooled-trials',
  }));

const goodputTable = [...goodputBySize.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([sizeBytes, values]) => {
    const b = bootstrapCi95(values);
    const cpu = bootstrapCi95(streamPublishCpuBySize.get(sizeBytes) ?? []);
    return {
      sizeBytes,
      sizeLabel: sizeLabel(sizeBytes),
      ...b,
      goodputMbps: b?.mean ?? null,
      publishCpuMs: cpu?.mean ?? null,
      publishCpuP50: cpu?.p50 ?? null,
      ciMethod: 'bootstrap-across-seeds',
    };
  });

const publishCpuTable = [...publishCpuBySize.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([sizeBytes, values]) => ({
    sizeBytes,
    sizeLabel: sizeLabel(sizeBytes),
    ...bootstrapCi95(values),
    ciMethod: 'bootstrap-across-seeds',
  }));

const latencyDecompositionTable = [...latencyBySize.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([sizeBytes, values]) => {
    const total = stats(values);
    const crypto = stats(publishCpuLatencyBySize.get(sizeBytes) ?? []);
    const sync = stats(syncTransferBySize.get(sizeBytes) ?? []);
    return {
      sizeBytes,
      sizeLabel: sizeLabel(sizeBytes),
      n: total?.n ?? 0,
      totalP50: total?.p50 ?? null,
      totalMean: total?.mean ?? null,
      ci95Low: total?.ci95Low ?? null,
      ci95High: total?.ci95High ?? null,
      publishCpuP50: crypto?.p50 ?? null,
      publishCpuMean: crypto?.mean ?? null,
      syncTransferP50: sync?.p50 ?? null,
      syncTransferMean: sync?.mean ?? null,
    };
  });

const campaign = {
  generatedAt: new Date().toISOString(),
  topology,
  profile: 'campaign',
  campaignSeeds: reports.length,
  seedIds: reports.map((r) => r.seed),
  statistics: {
    latency:
      'Pool all per-trial oneWayLatencyMs across seeds (n = seeds × repeats per size). CI: Student-t on the pooled sample.',
    goodput:
      'One goodput sample per seed per stream size. CI: bootstrap percentile (2000 resamples) across seeds.',
    publishCpu:
      'Mean publishCpuMs per seed per size (latency trials + stream publish). CI: bootstrap across seeds.',
  },
  swarmFormation: {
    sender: stats(friendSessionSender),
    receiver: stats(friendSessionReceiver),
  },
  latencyTable,
  latencyDecompositionTable,
  goodputTable,
  publishCpuTable,
  perSeed: reports.map((r) => ({
    seed: r.seed,
    latencyTable: r.report.latencyTable,
    goodputTable: r.report.goodputTable,
  })),
};

await writeBenchReport(outPath, campaign);

const quiet = process.argv.includes('--quiet');
if (!quiet) {
  printBenchReport(campaign, { title: 'Campaign aggregate', reportPath: outPath });
} else {
  console.log(`Wrote ${outPath}`);
}
