#!/usr/bin/env node
/**
 * Direct-transport benchmark that exercises the production nearbytes-sync
 * receiver sink (worker-hash + async pwrite) and the production tcpBulk
 * sender pump, without going through encryption / discovery / handshake.
 *
 * Use this to test single-block throughput up to whatever fits on disk
 * (the AES-GCM 256 MiB limit applies only to fileService.addFile()).
 *
 *   node --max-old-space-size=8192 scripts/bench-direct-large.mjs <size-bytes> [runs=5]
 */

import { createServer, connect } from 'node:net';
import { closeSync, openSync, writeSync, mkdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = Number(process.argv[2] ?? 134217728);
const RUNS = Number(process.argv[3] ?? 5);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Use the real production sink — same code path the full sync stack uses.
const { createDiskBlockStreamSink } = await import(
  join(ROOT, '../nearbytes-sync/dist/node/blockReceive.js')
);
const { pumpBlockFileOverSocket } = await import(
  join(ROOT, '../nearbytes-sync/dist/node/tcpBulk.js')
);

function tuneTcp(s) {
  s.setNoDelay(true);
  try {
    s.setSendBufferSize?.(16 << 20);
    s.setReceiveBufferSize?.(16 << 20);
  } catch {}
}

function makeTile() {
  const tile = Buffer.allocUnsafe(1 << 20);
  let s = 0x12345678 >>> 0;
  for (let i = 0; i < tile.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    tile[i] = s & 0xff;
  }
  return tile;
}

const TILE = makeTile();

async function resolveBlockPath(rootDir, hash) {
  const { blockPath } = await import(join(ROOT, '../nearbytes-log/dist/index.js'));
  return join(rootDir, blockPath(hash));
}

/**
 * Writes a `size`-byte file by repeating a 1 MiB deterministic tile and computes
 * its SHA-256 streaming-style, never materializing the full payload in JS memory.
 */
async function writeSenderBlock(rootDir, size) {
  const h = createHash('sha256');
  // Compute the hash first (over the same tile pattern) so we know the target path.
  let remaining = size;
  while (remaining > 0) {
    const take = remaining >= TILE.length ? TILE.length : remaining;
    h.update(take === TILE.length ? TILE : TILE.subarray(0, take));
    remaining -= take;
  }
  const hash = h.digest('hex');
  const abs = await resolveBlockPath(rootDir, hash);
  mkdirSync(dirname(abs), { recursive: true });
  const fd = openSync(abs, 'w');
  remaining = size;
  while (remaining > 0) {
    const take = remaining >= TILE.length ? TILE.length : remaining;
    writeSync(fd, TILE, 0, take);
    remaining -= take;
  }
  closeSync(fd);
  return hash;
}

async function runOnce(runIdx) {
  const tmpBase = join(tmpdir(), `nb-direct-${process.pid}-${runIdx}`);
  const senderDir = join(tmpBase, 'sender');
  const receiverDir = join(tmpBase, 'receiver');
  mkdirSync(senderDir, { recursive: true });
  mkdirSync(receiverDir, { recursive: true });

  const hash = await writeSenderBlock(senderDir, SIZE);

  let serverDone;
  const serverPromise = new Promise((resolve) => (serverDone = resolve));
  const server = createServer((socket) => {
    tuneTcp(socket);
    const sink = createDiskBlockStreamSink(receiverDir, hash, SIZE);
    let headerSkipped = false;
    let headerBytesNeeded = 0;
    let headerCarry = Buffer.alloc(0);
    let chunks = 0;
    let totalBytes = 0;
    let minChunk = Infinity;
    let maxChunk = 0;
    socket.on('data', (chunk) => {
      if (!headerSkipped) {
        headerCarry = Buffer.concat([headerCarry, chunk]);
        if (headerCarry.length < 4) return;
        const frameLen = headerCarry.readUInt32BE(0);
        if (headerBytesNeeded === 0) headerBytesNeeded = 4 + frameLen;
        if (headerCarry.length < headerBytesNeeded) return;
        const body = headerCarry.subarray(headerBytesNeeded);
        headerSkipped = true;
        if (body.length > 0) {
          chunks++;
          totalBytes += body.length;
          if (body.length < minChunk) minChunk = body.length;
          if (body.length > maxChunk) maxChunk = body.length;
          sink.ingest(body);
        }
        return;
      }
      chunks++;
      totalBytes += chunk.length;
      if (chunk.length < minChunk) minChunk = chunk.length;
      if (chunk.length > maxChunk) maxChunk = chunk.length;
      sink.ingest(chunk);
    });
    socket.on('end', async () => {
      const finishResult = await sink.finish();
      serverDone({
        phases: finishResult.phases,
        outcome: finishResult.outcome,
        chunks, avgChunk: totalBytes / chunks, minChunk, maxChunk,
      });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const t0 = Date.now();
  const client = connect(port, '127.0.0.1');
  await new Promise((r) => client.once('connect', r));
  tuneTcp(client);
  const pump = await pumpBlockFileOverSocket(client, senderDir, hash);
  client.end();
  const result = await serverPromise;
  const t1 = Date.now();
  server.close();
  rmSync(tmpBase, { recursive: true, force: true });

  if (result.outcome !== 'stored') {
    throw new Error(`receiver outcome ${result.outcome}`);
  }
  const phases = result.phases;
  const wire = phases.lastByteAt - phases.firstByteAt;
  const drain = (phases.diskDrainDoneAt ?? phases.lastByteAt) - phases.lastByteAt;
  const hashMs = phases.hashDoneAt - (phases.diskDrainDoneAt ?? phases.lastByteAt);
  const rename = phases.renameDoneAt - phases.hashDoneAt;
  const total = t1 - t0;
  const pumpMs = pump.pumpEndAt - pump.pumpBeginAt;
  return {
    wire, drain, hash: hashMs, rename, total, pump: pumpMs,
    chunks: result.chunks, avgChunk: result.avgChunk, minChunk: result.minChunk, maxChunk: result.maxChunk,
  };
}

function stats(xs) {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return null;
  return {
    min: s[0], max: s[s.length - 1], median: s[Math.floor(s.length / 2)],
    mean: s.reduce((a, b) => a + b, 0) / s.length, n: s.length,
  };
}

function fmtTime(ms) { return ms == null ? 'n/a' : `${ms.toFixed(0)} ms`; }
function fmtMbps(ms, bytes) {
  if (!ms || ms <= 0) return '';
  const m = (bytes * 8) / ms / 1000;
  return m >= 1000 ? `${(m / 1000).toFixed(2)} Gb/s` : `${m.toFixed(0)} Mb/s`;
}

(async () => {
  const sizeLabel = SIZE >= 1 << 30 ? `${(SIZE / (1 << 30)).toFixed(2)} GiB` : `${(SIZE / (1 << 20)).toFixed(0)} MiB`;
  console.log(`bench-direct-large: ${sizeLabel}, ${RUNS} runs, production sink + pump`);
  console.log('writing source file with deterministic LCG tile (no in-RAM buffer)\n');
  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    try {
      const r = await runOnce(i);
      runs.push(r);
      console.log(
        `run ${i}/${RUNS}: pump=${r.pump}ms wire=${r.wire}ms drain=${r.drain}ms hash=${r.hash}ms rename=${r.rename}ms total=${r.total}ms chunks=${r.chunks} avg=${(r.avgChunk/1024).toFixed(1)}KB min=${(r.minChunk/1024).toFixed(1)}KB max=${(r.maxChunk/1024).toFixed(1)}KB`,
      );
    } catch (e) {
      console.error(`run ${i} failed:`, e.message);
    }
  }
  if (runs.length === 0) process.exit(1);
  const cols = [
    ['SEND pump', 'pump'],
    ['RECV wire (1st→last)', 'wire'],
    ['RECV drain', 'drain'],
    ['RECV hash tail', 'hash'],
    ['RECV rename', 'rename'],
    ['TOTAL wall-clock', 'total'],
  ];
  console.log('\n=== aggregate ===');
  console.log('%s   %s %s %s %s %s', 'phase'.padEnd(26), 'min'.padStart(9), 'med'.padStart(9), 'mean'.padStart(10), 'max'.padStart(9), 'median throughput'.padStart(18));
  for (const [label, k] of cols) {
    const s = stats(runs.map((r) => r[k]));
    if (!s) continue;
    console.log('%s   %s %s %s %s %s',
      label.padEnd(26),
      fmtTime(s.min).padStart(9),
      fmtTime(s.median).padStart(9),
      fmtTime(s.mean).padStart(10),
      fmtTime(s.max).padStart(9),
      fmtMbps(s.median, SIZE).padStart(18),
    );
  }
  // Worker pool keeps the event loop alive; exit explicitly after stats.
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
