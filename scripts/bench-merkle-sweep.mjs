#!/usr/bin/env node
/**
 * Sweep over block size × leaf size × parallelism for computeMerkleHash, and
 * compare against single-thread SHA-256. Produces a JSON+TSV report that the
 * paper can include directly as Appendix table data.
 *
 * Usage:
 *   node scripts/bench-merkle-sweep.mjs [outDir]
 */

import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { computeMerkleHash } from 'nearbytes-crypto';

const OUT_DIR = process.argv[2] ?? 'results/merkle-sweep';
mkdirSync(OUT_DIR, { recursive: true });

const SIZES_MIB = [1, 4, 16, 64, 256, 1024, 4096];
const LEAF_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024]; // 64 KiB, 256 KiB, 1 MiB
const CORES = availableParallelism();
const PARALLELISMS = [1, 2, 4, 8, 16, CORES].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
const RUNS = 5;

function buildPayload(size) {
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

function gbps(bytes, ms) {
  return (bytes * 8) / (ms / 1000) / 1e9;
}

async function timed(fn) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    await fn();
    times.push(Date.now() - t0);
  }
  return Math.round(median(times));
}

async function sweep() {
  const rows = [];
  for (const sizeMiB of SIZES_MIB) {
    const size = sizeMiB * 1024 * 1024;
    console.log(`\n## ${sizeMiB} MiB ##`);
    const payload = buildPayload(size);

    // Plain SHA-256 (serial, chunked to bypass 2 GiB update limit).
    const serialMs = await timed(() => {
      const h = createHash('sha256');
      const CHUNK = 1 << 30;
      for (let off = 0; off < payload.length; off += CHUNK) {
        h.update(payload.subarray(off, Math.min(off + CHUNK, payload.length)));
      }
      h.digest('hex');
    });
    console.log(`  plain SHA-256        : ${serialMs} ms = ${gbps(size, serialMs).toFixed(2)} Gb/s`);
    rows.push({ size_mib: sizeMiB, leaf_kib: 0, p: 0, ms: serialMs, gbps: +gbps(size, serialMs).toFixed(2), variant: 'plain-sha256' });

    for (const leafSize of LEAF_SIZES) {
      const leafLabel = `${(leafSize / 1024).toFixed(0).padStart(4)}K`;
      for (const p of PARALLELISMS) {
        // Skip cases where # leaves < p (no parallelism gain).
        const nLeaves = Math.ceil(size / leafSize);
        if (p > nLeaves && p > 1) continue;
        const ms = await timed(() => computeMerkleHash(payload, { leafSize, parallelism: p }));
        const tp = gbps(size, ms);
        console.log(`  MTH leaf=${leafLabel} p=${String(p).padStart(2)}: ${String(ms).padStart(5)} ms = ${tp.toFixed(2).padStart(6)} Gb/s`);
        rows.push({ size_mib: sizeMiB, leaf_kib: leafSize / 1024, p, ms, gbps: +tp.toFixed(2), variant: 'mth' });
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(OUT_DIR, `sweep-${stamp}.json`);
  const tsvPath = join(OUT_DIR, `sweep-${stamp}.tsv`);
  writeFileSync(jsonPath, JSON.stringify({ host: { cores: CORES }, rows }, null, 2));
  const tsvLines = ['size_mib\tleaf_kib\tp\tms\tgbps\tvariant'];
  for (const r of rows) tsvLines.push([r.size_mib, r.leaf_kib, r.p, r.ms, r.gbps, r.variant].join('\t'));
  writeFileSync(tsvPath, tsvLines.join('\n'));
  console.log(`\n# Wrote ${jsonPath}\n# Wrote ${tsvPath}`);
}

sweep().catch((err) => {
  console.error(err);
  process.exit(1);
});
