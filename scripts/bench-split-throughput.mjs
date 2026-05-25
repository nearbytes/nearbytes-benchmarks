#!/usr/bin/env node
/**
 * Decompose bench wall-clock timings into wire / hash / rename / reception phases.
 *
 *   node scripts/bench-split-throughput.mjs <bench-base-dir>
 *
 *   The directory is the parent that contains `alice/` and `bob/` runs.
 *   Reads each role's `data/sync/activity.log` and prints split throughputs.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readEvents(role, base) {
  const p = join(base, role, 'data/sync/activity.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.includes('bench {'))
    .map((l) => JSON.parse(l.split('bench ', 2)[1]));
}

function fmtThroughput(bytes, ms) {
  if (!bytes || !ms || ms <= 0) return '';
  const mbps = (bytes * 8) / ms / 1000;
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gb/s`;
  return `${mbps.toFixed(0)} Mb/s`;
}

function fmtMs(ms) {
  if (ms < 0) return '   <0 ms';
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(0)} ms`;
}

function describe(label, bytes, ms) {
  return `${label.padEnd(34)} ${fmtMs(ms).padStart(9)}   ${fmtThroughput(bytes, ms).padStart(12)}`;
}

const base = process.argv[2];
if (!base) {
  console.error('usage: bench-split-throughput.mjs <bench-base-dir>');
  process.exit(2);
}

const alice = readEvents('alice', base);
const bob = readEvents('bob', base);

const bigPub = alice
  .filter((e) => e.bench === 'file-published' && (e.sizeBytes ?? 0) > 1e7)
  .pop();
const bigRecv = bob
  .filter((e) => e.bench === 'inbound-stored' && (e.bytes ?? 0) > 1e7)
  .pop();
const send = alice
  .filter((e) => e.bench === 'bulk-send-phases' && (e.bytes ?? 0) > 1e7)
  .pop();
const recv = bob
  .filter((e) => e.bench === 'bulk-recv-phases' && (e.bytes ?? 0) > 1e7)
  .pop();

if (!recv) {
  console.error('no bulk-recv-phases event for a large block in bob log');
  process.exit(1);
}

const bytes = recv.bytes;
const head = `==== bulk block ${bytes} B (${(bytes / 1024 / 1024).toFixed(1)} MiB) ====`;
console.log(`\n${head}\n`);
console.log(`${'phase'.padEnd(34)} ${'time'.padStart(9)}   ${'throughput'.padStart(12)}`);
console.log('-'.repeat(head.length));

if (send) {
  const sendDur = send.pumpEndAt - send.pumpBeginAt;
  console.log(describe('SEND  pump (kernel-queued)', bytes, sendDur));
}

const { firstByteAt, lastByteAt, diskDrainDoneAt, hashDoneAt, renameDoneAt } = recv;
const drainAt = diskDrainDoneAt ?? lastByteAt;
if (firstByteAt != null && lastByteAt != null) {
  console.log(describe('RECV  wire (first→last byte)', bytes, lastByteAt - firstByteAt));
  if (drainAt != null) {
    console.log(describe('RECV  disk drain (async writes)', bytes, drainAt - lastByteAt));
  }
  console.log(describe('RECV  hash verify (read+sha256)', bytes, hashDoneAt - drainAt));
  console.log(describe('RECV  rename', 0, renameDoneAt - hashDoneAt));
}

if (bigPub && bigRecv) {
  console.log('-'.repeat(head.length));
  const total = bigRecv.t - bigPub.t;
  console.log(describe('TOTAL publish→inbound-stored', bytes, total));
  if (firstByteAt != null) {
    console.log(describe('  ├─ publish→first-byte', 0, firstByteAt - bigPub.t));
  }
  if (lastByteAt != null && firstByteAt != null) {
    console.log(describe('  ├─ wire', bytes, lastByteAt - firstByteAt));
  }
  if (drainAt != null && lastByteAt != null) {
    console.log(describe('  ├─ disk drain', 0, drainAt - lastByteAt));
  }
  if (drainAt != null) {
    console.log(describe('  ├─ hash verify', 0, hashDoneAt - drainAt));
    console.log(describe('  ├─ rename', 0, renameDoneAt - hashDoneAt));
    console.log(describe('  └─ reception-log + marker', 0, bigRecv.t - renameDoneAt));
  }
}

console.log('');
