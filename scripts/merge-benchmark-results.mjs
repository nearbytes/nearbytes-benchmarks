#!/usr/bin/env node
/**
 * Merge sender + receiver benchmark JSON into a research report (stdout + JSON file).
 */

import { readFile, mkdir } from 'fs/promises';
import { writeBenchReport } from './bench-json.mjs';
import { printBenchReport } from './bench-report-print.mjs';
import path from 'path';
import {
  stats,
  sizeLabel,
  parseBenchActivityLines,
  goodputFromInboundMarkers,
  isWarmupTrialName,
  statsTableFromValues,
} from './benchmark-stats.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function loadJson(p) {
  return JSON.parse(await readFile(p, 'utf-8'));
}

const senderPath = arg('--sender', '');
const manifestPath = arg('--manifest', '');
const receiverPath = arg('--receiver', '');
const defaultOut = path.join(process.cwd(), '.local/bench/reports/merged/bench-report.json');
const outPath = arg('--out', defaultOut);
const topology = arg(
  '--topology',
  process.env['NEARBYTES_BENCH_TOPOLOGY'] ?? 'mac-alice to pc-ciancia-bob',
);

if (!senderPath || !receiverPath) {
  console.error('Need --sender and --receiver benchmark-result.json paths');
  process.exit(1);
}

const sender = await loadJson(senderPath);
const receiver = await loadJson(receiverPath);
const trialAckTimeoutMs = Number(process.env['NEARBYTES_BENCH_TRIAL_ACK_MS'] ?? 0) || 0;
const coordinatedTrials = sender.meta?.mode === 'paper';
const manifest = (manifestPath ? await loadJson(manifestPath) : []).filter(
  (t) => !isWarmupTrialName(t.name),
);

const recvByName = new Map();
for (const row of receiver.latency ?? []) {
  if (row.receiveWallMs !== undefined && !isWarmupTrialName(row.name)) {
    recvByName.set(row.name, row.receiveWallMs);
  }
}

const inboundBlocks = parseBenchActivityLines(receiver.activityLog).filter(
  (e) => e.bench === 'inbound-stored' && e.kind === 'block',
);

const publishByName = new Map();
for (const e of parseBenchActivityLines(sender.activityLog)) {
  if (e.bench === 'file-published' && e.name) {
    publishByName.set(e.name, e.t);
  }
}

function blockMatchesTrial(blockBytes, sizeBytes) {
  return blockBytes >= sizeBytes && blockBytes <= sizeBytes + 512;
}

function trialWindowEnd(publishWallMs, nextPublishWallMs, trialAckTimeoutMs) {
  const nextBound = nextPublishWallMs != null ? nextPublishWallMs + 5000 : publishWallMs + 30_000;
  const ackBound = trialAckTimeoutMs > 0 ? publishWallMs + trialAckTimeoutMs : nextBound;
  return Math.max(nextBound, ackBound);
}

const friendSessionGapMs =
  sender.warmup?.swarmFormationMs != null &&
  receiver.warmup?.swarmFormationMs != null
    ? receiver.warmup.swarmFormationMs - sender.warmup.swarmFormationMs
    : null;

let inboundIdx = 0;
const mergedTrials = [];
for (let i = 0; i < manifest.length; i++) {
  const trial = manifest[i];
  const publishWallMs = publishByName.get(trial.name) ?? trial.publishWallMs;
  const nextPublish =
    publishByName.get(manifest[i + 1]?.name) ?? manifest[i + 1]?.publishWallMs;
  const windowEnd = coordinatedTrials
    ? trialWindowEnd(
        publishWallMs,
        publishByName.get(manifest[i + 1]?.name) ?? manifest[i + 1]?.publishWallMs,
        trialAckTimeoutMs || 120_000,
      )
    : (nextPublish ?? publishWallMs + 30_000) + 5000;
  const receiveWallMs = recvByName.get(trial.name);
  const listLatencyMs =
    receiveWallMs !== undefined ? receiveWallMs - publishWallMs : null;
  let inbound = null;
  while (inboundIdx < inboundBlocks.length) {
    const cand = inboundBlocks[inboundIdx];
    if (cand.t < publishWallMs) {
      inboundIdx++;
      continue;
    }
    if (cand.t > windowEnd) break;
    if (blockMatchesTrial(cand.bytes, trial.sizeBytes)) {
      inbound = cand;
      inboundIdx++;
      break;
    }
    inboundIdx++;
  }
  const syncLatencyMs = inbound ? inbound.t - publishWallMs : null;
  const oneWayLatencyMs =
    syncLatencyMs ??
    (listLatencyMs !== null && listLatencyMs >= 0 ? listLatencyMs : null);
  const publishCpuMs = trial.publishCpuMs ?? null;
  const syncTransferMs =
    oneWayLatencyMs != null && publishCpuMs != null
      ? Math.max(0, oneWayLatencyMs - publishCpuMs)
      : null;
  mergedTrials.push({
    ...trial,
    receiveWallMs,
    listLatencyMs,
    syncLatencyMs,
    inboundStoredAt: inbound?.t ?? null,
    oneWayLatencyMs,
    publishCpuMs,
    syncTransferMs,
  });
}

function tableFromField(field) {
  const bySize = new Map();
  for (const t of mergedTrials) {
    const v = t[field];
    if (v === null || v === undefined || v < 0) continue;
    if (!bySize.has(t.sizeBytes)) bySize.set(t.sizeBytes, []);
    bySize.get(t.sizeBytes).push(v);
  }
  return [...bySize.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sizeBytes, values]) => ({
      sizeBytes,
      sizeLabel: sizeLabel(sizeBytes),
      ...stats(values),
    }))
    .filter((r) => r.n > 0);
}

const latencyTable = tableFromField('oneWayLatencyMs');
const listLatencyTable = tableFromField('listLatencyMs');
const syncLatencyTable = tableFromField('syncLatencyMs');
const latencyDecompositionTable = tableFromField('oneWayLatencyMs').map((row) => {
  const crypto = tableFromField('publishCpuMs').find((r) => r.sizeBytes === row.sizeBytes);
  const sync = tableFromField('syncTransferMs').find((r) => r.sizeBytes === row.sizeBytes);
  return {
    sizeBytes: row.sizeBytes,
    sizeLabel: row.sizeLabel,
    n: row.n,
    totalP50: row.p50,
    publishCpuP50: crypto?.p50 ?? null,
    syncTransferP50: sync?.p50 ?? null,
    publishCpuMean: crypto?.mean ?? null,
    syncTransferMean: sync?.mean ?? null,
    totalMean: row.mean,
    ci95Low: row.ci95Low,
    ci95High: row.ci95High,
  };
});

const senderStreams = sender.throughput?.streams ?? [];
const receiverStreams = receiver.throughput?.streams ?? [];
const streamRows =
  senderStreams.length > 0
    ? senderStreams
    : receiverStreams.length > 0
      ? receiverStreams
      : [];
const goodputTable = streamRows.map((s) => {
  const recv =
    receiverStreams.find((r) => r.streamIndex === s.streamIndex) ??
    receiverStreams.find((r) => r.sizeBytes === s.sizeBytes);
  const g = goodputFromInboundMarkers(
    receiver.activityLog,
    s.sizeBytes,
    sender.activityLog,
    undefined,
    s.streamIndex,
  );
  return {
    streamIndex: s.streamIndex,
    sizeBytes: s.sizeBytes,
    sizeLabel: sizeLabel(s.sizeBytes),
    publishCpuMs: s.publishCpuMs ?? recv?.publishCpuMs ?? null,
    goodputMbps: g?.goodputMbps ?? recv?.goodputMbps ?? s.goodputMbps ?? null,
    inboundDurationMs: g?.durationMs ?? recv?.inboundDurationMs ?? s.inboundDurationMs ?? null,
    bytesReceived: g?.bytesReceived ?? recv?.bytesReceived ?? s.bytesReceived ?? null,
  };
});

const publishCpuBySize = new Map();
for (const t of manifest) {
  if (t.publishCpuMs == null) continue;
  if (!publishCpuBySize.has(t.sizeBytes)) publishCpuBySize.set(t.sizeBytes, []);
  publishCpuBySize.get(t.sizeBytes).push(t.publishCpuMs);
}
for (const s of senderStreams) {
  if (s.publishCpuMs == null) continue;
  if (!publishCpuBySize.has(s.sizeBytes)) publishCpuBySize.set(s.sizeBytes, []);
  publishCpuBySize.get(s.sizeBytes).push(s.publishCpuMs);
}
const publishCpuTable = statsTableFromValues(publishCpuBySize);

const primaryGoodput = goodputTable.find((r) => r.sizeBytes === 32 * 1024 * 1024) ?? goodputTable[0];
const receiverGoodputMbps = primaryGoodput?.goodputMbps ?? null;

const report = {
  generatedAt: new Date().toISOString(),
  topology,
  phases: {
    sender: sender.phases ?? null,
    receiver: receiver.phases ?? null,
  },
  impl: sender.meta?.impl,
  profile: sender.meta?.mode ?? null,
  methodology: {
    latencyMetric:
      'oneWayLatencyMs: wall time from sender file-published marker to receiver first inbound-stored block for that payload (NTP assumed on same host; cross-host requires synchronized clocks).',
    latencyWarmup:
      'Warmup payloads (bench-lat-warm-*) are published but excluded from manifest and statistics.',
    throughputMetric:
      'Sustained goodput: nominal payload bytes × 8 / (t_last_inbound_block − t_first_inbound_block) between throughput-phase-start/end markers.',
    repeatsPerSize: latencyTable[0]?.n ?? null,
  },
  latencyNote:
    'syncLatencyMs equals oneWayLatencyMs when inbound-stored is available. listLatencyMs is listFiles poll (upper bound).',
  swarmFormation: {
    senderMs: sender.warmup?.swarmFormationMs ?? null,
    receiverMs: receiver.warmup?.swarmFormationMs ?? null,
    friendSessionGapMs,
  },
  profilePublishCpuMs: {
    sender: sender.warmup?.profilePublishMs,
    receiver: receiver.warmup?.profilePublishMs,
  },
  latencyTable,
  listLatencyTable,
  syncLatencyTable,
  latencyDecompositionTable,
  goodputTable,
  publishCpuTable,
  mergedTrials,
  throughput: {
    mode: receiver.throughput?.mode ?? sender.throughput?.mode ?? null,
    streams: goodputTable,
    receiverGoodputMbps,
    primaryStreamBytes: primaryGoodput?.sizeBytes ?? null,
  },
  senderMarkers:
    sender.markers?.filter(
      (m) =>
        m.event?.includes('peer') ||
        m.event?.includes('inbound') ||
        m.event?.includes('friend'),
    ) ?? [],
  receiverMarkers:
    receiver.markers?.filter(
      (m) =>
        m.event?.includes('peer') ||
        m.event?.includes('inbound') ||
        m.event?.includes('friend'),
    ) ?? [],
  senderReceptionTail: sender.receptionTail ?? [],
  receiverReceptionTail: receiver.receptionTail ?? [],
  senderActivity: sender.activityLog ?? [],
  receiverActivity: receiver.activityLog ?? [],
};

await writeBenchReport(outPath, report);

const quiet = process.argv.includes('--quiet') || process.env['NEARBYTES_BENCH_MERGE_QUIET'] === '1';
if (quiet) {
  console.log(`Wrote ${outPath}`);
} else {
  printBenchReport(report, { title: 'Merged seed report', reportPath: outPath });
}
