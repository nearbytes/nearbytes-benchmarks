#!/usr/bin/env node
/**
 * Merge alice + bob bidirectional-result.json into sync-report.json (metrics + phases).
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const alicePath = arg('--alice', '');
const bobPath = arg('--bob', '');
const outPath = arg('--out', 'sync-report.json');
const topology = arg('--topology', 'localhost bidirectional');

if (!alicePath || !bobPath) {
  console.error('Usage: --alice <alice/bidirectional-result.json> --bob <bob/...> [--out ...]');
  process.exit(1);
}

const alice = JSON.parse(await readFile(alicePath, 'utf-8'));
const bob = JSON.parse(await readFile(bobPath, 'utf-8'));
const payloadBytes = alice.meta?.payloadBytes ?? bob.meta?.payloadBytes ?? 0;

const aliceRecv = alice.phases?.receiveMs ?? null;
const bobRecv = bob.phases?.receiveMs ?? null;
const totalBytes = payloadBytes * 2;
const spanMs =
  aliceRecv !== null && bobRecv !== null ? Math.max(aliceRecv, bobRecv) : null;
const goodputMbps =
  spanMs !== null && spanMs > 0 ? (totalBytes * 8) / (spanMs * 1000) : null;

const report = {
  generatedAt: new Date().toISOString(),
  topology,
  impl: 'nearbytes-sync-v0-hyperswarm-mdns',
  profile: 'bidirectional-1mib',
  latencyNote:
    'Bidirectional 1 MiB each way after friend-session-attached. receiveMs is listFiles wait per peer.',
  swarmFormation: {
    senderMs: alice.phases?.friendSessionMs ?? null,
    receiverMs: bob.phases?.friendSessionMs ?? null,
    clockOffsetEstimateMs: null,
  },
  phases: {
    alice: alice.phases,
    bob: bob.phases,
  },
  latencyTable: [
    {
      sizeBytes: payloadBytes,
      sizeLabel: payloadBytes >= 1024 * 1024 ? `${payloadBytes / (1024 * 1024)} MiB` : `${payloadBytes / 1024} KiB`,
      n: 2,
      p50: spanMs !== null ? spanMs : null,
      p95: spanMs,
      mean: spanMs,
      min: Math.min(aliceRecv ?? Infinity, bobRecv ?? Infinity) === Infinity ? null : Math.min(aliceRecv ?? 0, bobRecv ?? 0),
      max: Math.max(aliceRecv ?? 0, bobRecv ?? 0),
    },
  ],
  syncLatencyTable: [],
  throughput: {
    senderPublishMs: alice.phases?.publishMs ?? null,
    receiverGoodputMbps: goodputMbps,
  },
  senderMarkers: alice.markers ?? [],
  receiverMarkers: bob.markers ?? [],
};

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
