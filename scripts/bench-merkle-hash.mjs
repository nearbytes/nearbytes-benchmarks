#!/usr/bin/env node
/**
 * Benchmark and correctness comparison: serial SHA-256 vs parallel RFC 6962 §2.1
 * Merkle Tree Hash over SHA-256 (computeMerkleHash, nearbytes-crypto).
 *
 * Usage: node scripts/bench-merkle-hash.mjs [SIZE_MIB] [RUNS]
 * Defaults to 4096 MiB (4 GiB) and 5 runs at each parallelism level.
 */

import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { computeMerkleHash } from 'nearbytes-crypto';

const SIZE_MIB = parseInt(process.argv[2] ?? '4096', 10);
const RUNS = parseInt(process.argv[3] ?? '5', 10);
const SIZE = SIZE_MIB * 1024 * 1024;
const CORES = availableParallelism();

function fmtGbps(bytes, ms) {
  return ((bytes * 8) / (ms / 1000) / 1e9).toFixed(2);
}

function fmtRow(label, ms, bytes) {
  return `  ${label.padEnd(28)} ${String(ms).padStart(6)} ms   ${fmtGbps(bytes, ms).padStart(7)} Gb/s`;
}

function buildPayload(size) {
  // Allocate once over a SharedArrayBuffer so the parallel MTH path does NOT
  // need to memcpy 4 GiB into a SAB before every call. Pre-touch each page so
  // first-touch faults are charged to build, not to the measured hash window.
  const sab = new SharedArrayBuffer(size);
  const buf = Buffer.from(sab);
  const tile = Buffer.allocUnsafe(1 << 20);
  for (let i = 0; i < tile.length; i++) tile[i] = (i * 31 + 7) & 0xff;
  for (let off = 0; off < size; off += tile.length) {
    const end = Math.min(off + tile.length, size);
    tile.copy(buf, off, 0, end - off);
  }
  return buf;
}

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function runCorrectnessChecks() {
  console.log('=== Correctness ===');
  const sha256OfEmpty = createHash('sha256').digest('hex');
  const mthEmpty = await computeMerkleHash(new Uint8Array(0));
  console.log(`  MTH({})       = ${mthEmpty}`);
  console.log(`  SHA-256()     = ${sha256OfEmpty}  (expected match)`);
  if (mthEmpty !== sha256OfEmpty) throw new Error('MTH({}) != SHA-256()');

  const oneLeaf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const expectedOne = createHash('sha256')
    .update(Buffer.concat([Buffer.from([0x00]), oneLeaf]))
    .digest('hex');
  const mthOne = await computeMerkleHash(oneLeaf, { leafSize: 1 << 20 });
  console.log(`  MTH({d0})     = ${mthOne}`);
  console.log(`  SHA-256(0x00||d0) = ${expectedOne}  (expected match)`);
  if (mthOne !== expectedOne) throw new Error('MTH({d0}) != SHA-256(0x00||d0)');

  // Serial vs parallel agreement on a non-trivial input.
  const sample = buildPayload(8 * 1024 * 1024);
  const serial = await computeMerkleHash(sample, { leafSize: 1 << 16, parallelism: 1 });
  const parallel = await computeMerkleHash(sample, { leafSize: 1 << 16, parallelism: CORES });
  console.log(`  MTH 8 MiB (serial)   = ${serial}`);
  console.log(`  MTH 8 MiB (parallel) = ${parallel}`);
  if (serial !== parallel) throw new Error('Serial and parallel MTH disagree');
  console.log('  OK\n');
}

async function bench() {
  console.log(`=== Bench: ${SIZE_MIB} MiB, ${RUNS} runs each, host has ${CORES} cores ===`);
  console.log(`Building deterministic payload (${SIZE_MIB} MiB)...`);
  const payload = buildPayload(SIZE);

  // Warm-up: touch every page and prime SHA-256/openssl path.
  await computeMerkleHash(payload.subarray(0, 1 << 20), { parallelism: 1 });

  const variants = [];

  // 1) Plain serial SHA-256 (status quo in nearbytes-sync). Node's hash.update
  //    rejects inputs >= 2 GiB, so we chunk for fairness.
  variants.push({
    label: 'plain SHA-256 (serial)',
    fn: () => {
      const h = createHash('sha256');
      const CHUNK = 1 << 30; // 1 GiB
      for (let off = 0; off < payload.length; off += CHUNK) {
        h.update(payload.subarray(off, Math.min(off + CHUNK, payload.length)));
      }
      return h.digest('hex');
    },
    isAsync: false,
  });

  // 2) MTH with parallelism = 1 (single thread, RFC 6962 reduction overhead only).
  variants.push({
    label: 'MTH parallelism=1',
    fn: () => computeMerkleHash(payload, { leafSize: 1 << 20, parallelism: 1 }),
    isAsync: true,
  });

  // 3) MTH with parallelism scaling: 2, 4, ..., CORES.
  const scales = [];
  for (let p = 2; p <= CORES; p *= 2) scales.push(p);
  if (scales[scales.length - 1] !== CORES) scales.push(CORES);
  for (const p of scales) {
    variants.push({
      label: `MTH parallelism=${p}`,
      fn: () => computeMerkleHash(payload, { leafSize: 1 << 20, parallelism: p }),
      isAsync: true,
    });
  }

  for (const v of variants) {
    const times = [];
    let digest;
    for (let i = 0; i < RUNS; i++) {
      const t0 = Date.now();
      digest = v.isAsync ? await v.fn() : v.fn();
      times.push(Date.now() - t0);
    }
    const med = Math.round(median(times));
    const min = Math.min(...times);
    const max = Math.max(...times);
    console.log(
      `${fmtRow(v.label, med, SIZE)}   (min ${String(min).padStart(4)} max ${String(max).padStart(4)})`,
    );
  }

  console.log(`\nSHA-256 single-thread hardware ceiling on this host: see openssl speed sha256`);
}

(async () => {
  await runCorrectnessChecks();
  await bench();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
