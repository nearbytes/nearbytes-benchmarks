#!/usr/bin/env node
/**
 * Same direct harness as bench-direct-large.mjs but with a "no-crypto" sink that
 * skips both the hash worker and the second memcpy. Used to isolate whether the
 * gap to the Node TCP→file baseline is due to crypto/copy or to something else.
 */

import { createServer, connect } from 'node:net';
import { closeSync, openSync, writeSync, mkdirSync, rmSync, close, open, write, createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { createHash as createHashLocal } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = Number(process.argv[2] ?? 4 * 1024 * 1024 * 1024);
const RUNS = Number(process.argv[3] ?? 5);
const MODE = process.argv[4] ?? 'nocrypto'; // nocrypto | passthrough | batched-nocrypto
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const { pumpBlockFileOverSocket } = await import(
  join(ROOT, '../nearbytes-sync/dist/node/tcpBulk.js')
);
const { blockPath } = await import(join(ROOT, '../nearbytes-log/dist/index.js'));

function tuneTcp(s) {
  s.setNoDelay(true);
  try {
    s.setSendBufferSize?.(16 << 20);
    s.setReceiveBufferSize?.(16 << 20);
  } catch {}
}

function openAsync(p) { return new Promise((res, rej) => open(p, 'w', (e, fd) => (e ? rej(e) : res(fd)))); }
function writeAsync(fd, b, l, p) { return new Promise((res, rej) => write(fd, b, 0, l, p, (e) => (e ? rej(e) : res()))); }
function closeAsync(fd) { return new Promise((res, rej) => close(fd, (e) => (e ? rej(e) : res()))); }

const TILE = (() => {
  const t = Buffer.allocUnsafe(1 << 20);
  let s = 0x12345678 >>> 0;
  for (let i = 0; i < t.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; t[i] = s & 0xff; }
  return t;
})();

async function writeSenderBlock(rootDir, size) {
  const h = createHash('sha256');
  let r = size;
  while (r > 0) { const t = r >= TILE.length ? TILE.length : r; h.update(t === TILE.length ? TILE : TILE.subarray(0, t)); r -= t; }
  const hash = h.digest('hex');
  const abs = join(rootDir, blockPath(hash));
  mkdirSync(dirname(abs), { recursive: true });
  const fd = openSync(abs, 'w');
  r = size;
  while (r > 0) { const t = r >= TILE.length ? TILE.length : r; writeSync(fd, TILE, 0, t); r -= t; }
  closeSync(fd);
  return hash;
}

/**
 * Mode "passthrough": passes the socket chunk reference directly to fs.write
 * (parallel pwrite). NO copy on main thread. NO hashing. Closest to Node TCP→file.
 */
function createPassthroughSink(receiverDir, hash, total) {
  const finalPath = join(receiverDir, blockPath(hash));
  const tmpPath = `${finalPath}.tmp`;
  mkdirSync(dirname(finalPath), { recursive: true });
  const fdPromise = openAsync(tmpPath);
  let received = 0, firstByteAt = null, lastByteAt = null;
  let inflight = 0;
  let allDone = false, doneResolve = null;
  const donePromise = new Promise((r) => (doneResolve = r));
  const tryResolve = () => { if (allDone && inflight === 0 && doneResolve) { doneResolve(); doneResolve = null; } };
  return {
    ingest(chunk) {
      if (received >= total) return;
      if (firstByteAt === null) firstByteAt = Date.now();
      const remaining = total - received;
      const usable = remaining < chunk.length ? remaining : chunk.length;
      const slice = usable === chunk.length ? chunk : chunk.subarray(0, usable);
      const pos = received;
      received += usable;
      inflight++;
      void (async () => {
        try { const fd = await fdPromise; await writeAsync(fd, slice, usable, pos); }
        finally { inflight--; tryResolve(); }
      })();
      if (received >= total) { lastByteAt = Date.now(); allDone = true; tryResolve(); }
    },
    async finish() {
      await donePromise;
      const fd = await fdPromise;
      await closeAsync(fd);
      const diskDrainDoneAt = Date.now();
      await rename(tmpPath, finalPath);
      return {
        firstByteAt, lastByteAt, diskDrainDoneAt,
        hashDoneAt: diskDrainDoneAt, renameDoneAt: Date.now(),
      };
    },
  };
}

/**
 * Mode "batched-nocrypto": same as passthrough but with the 4 MiB batch copy
 * (proxy for the unified-batch overhead WITHOUT the second copy + worker).
 */
function createBatchedNoCryptoSink(receiverDir, hash, total) {
  const BATCH = 4 << 20;
  const finalPath = join(receiverDir, blockPath(hash));
  const tmpPath = `${finalPath}.tmp`;
  mkdirSync(dirname(finalPath), { recursive: true });
  const fdPromise = openAsync(tmpPath);
  let received = 0, firstByteAt = null, lastByteAt = null;
  let inflight = 0, allDone = false, doneResolve = null;
  let batchBuf = Buffer.allocUnsafe(BATCH);
  let batchUsed = 0, batchPos = 0;
  const donePromise = new Promise((r) => (doneResolve = r));
  const tryResolve = () => { if (allDone && inflight === 0 && doneResolve) { doneResolve(); doneResolve = null; } };
  const flush = () => {
    if (batchUsed === 0) return;
    const buf = batchBuf; const len = batchUsed; const pos = batchPos;
    inflight++;
    void (async () => {
      try { const fd = await fdPromise; await writeAsync(fd, buf, len, pos); }
      finally { inflight--; tryResolve(); }
    })();
    batchPos += len; batchUsed = 0; batchBuf = Buffer.allocUnsafe(BATCH);
  };
  return {
    ingest(chunk) {
      if (received >= total) return;
      if (firstByteAt === null) firstByteAt = Date.now();
      const remaining = total - received;
      const usable = remaining < chunk.length ? remaining : chunk.length;
      const space = BATCH - batchUsed;
      if (usable <= space) {
        chunk.copy(batchBuf, batchUsed, 0, usable);
        batchUsed += usable; received += usable;
        if (batchUsed === BATCH) flush();
      } else {
        chunk.copy(batchBuf, batchUsed, 0, space);
        batchUsed += space; flush();
        const tail = usable - space;
        chunk.copy(batchBuf, 0, space, space + tail);
        batchUsed += tail; received += usable;
      }
      if (received >= total) { lastByteAt = Date.now(); flush(); allDone = true; tryResolve(); }
    },
    async finish() {
      await donePromise;
      const fd = await fdPromise;
      await closeAsync(fd);
      const diskDrainDoneAt = Date.now();
      await rename(tmpPath, finalPath);
      return { firstByteAt, lastByteAt, diskDrainDoneAt, hashDoneAt: diskDrainDoneAt, renameDoneAt: Date.now() };
    },
  };
}

/**
 * Mode "writestream-nocrypto": uses fs.createWriteStream exactly like the
 * Node TCP→file baseline. NO copy, NO hash. This tells us whether the
 * residual gap (31.8 → 38.8 Gb/s) is the parallel-pwrite strategy itself.
 */
function createWriteStreamSink(receiverDir, hash, total) {
  const finalPath = join(receiverDir, blockPath(hash));
  const tmpPath = `${finalPath}.tmp`;
  mkdirSync(dirname(finalPath), { recursive: true });
  const out = createWriteStream(tmpPath);
  let received = 0, firstByteAt = null, lastByteAt = null;
  let endResolve = null;
  const endPromise = new Promise((r) => (endResolve = r));
  return {
    ingest(chunk) {
      if (received >= total) return;
      if (firstByteAt === null) firstByteAt = Date.now();
      const remaining = total - received;
      const usable = remaining < chunk.length ? remaining : chunk.length;
      const slice = usable === chunk.length ? chunk : chunk.subarray(0, usable);
      out.write(slice);
      received += usable;
      if (received >= total) {
        lastByteAt = Date.now();
        out.end(() => endResolve());
      }
    },
    async finish() {
      await endPromise;
      const diskDrainDoneAt = Date.now();
      await rename(tmpPath, finalPath);
      return { firstByteAt, lastByteAt, diskDrainDoneAt, hashDoneAt: diskDrainDoneAt, renameDoneAt: Date.now() };
    },
  };
}

/**
 * Mode "writestream-hash": createWriteStream for disk + hash worker via 1 memcpy
 * (transferable). Two competing parallel paths from the same chunk reference.
 */
function spawnHashWorkerInline() {
  const SRC = `
    const { createHash } = require('node:crypto');
    const { parentPort } = require('node:worker_threads');
    const h = createHash('sha256');
    parentPort.on('message', (m) => {
      if (m.type === 'chunk') { h.update(Buffer.from(m.buf)); return; }
      if (m.type === 'final') { parentPort.postMessage({ digest: h.digest('hex') }); parentPort.close(); }
    });
  `;
  const w = new Worker(SRC, { eval: true });
  const digest = new Promise((res) => w.once('message', (m) => res(m.digest)));
  return { worker: w, digest };
}

function createWriteStreamHashSink(receiverDir, hash, total) {
  const finalPath = join(receiverDir, blockPath(hash));
  const tmpPath = `${finalPath}.tmp`;
  mkdirSync(dirname(finalPath), { recursive: true });
  const out = createWriteStream(tmpPath);
  const { worker, digest } = spawnHashWorkerInline();
  let received = 0, firstByteAt = null, lastByteAt = null;
  let endResolve = null;
  const endPromise = new Promise((r) => (endResolve = r));
  return {
    ingest(chunk) {
      if (received >= total) return;
      if (firstByteAt === null) firstByteAt = Date.now();
      const remaining = total - received;
      const usable = remaining < chunk.length ? remaining : chunk.length;
      const slice = usable === chunk.length ? chunk : chunk.subarray(0, usable);
      // Hash worker: transferable copy (one memcpy per chunk).
      const detachable = new Uint8Array(usable);
      detachable.set(slice);
      worker.postMessage({ type: 'chunk', buf: detachable.buffer }, [detachable.buffer]);
      // Disk: pass slice reference straight to writeStream (no copy here).
      out.write(slice);
      received += usable;
      if (received >= total) {
        lastByteAt = Date.now();
        worker.postMessage({ type: 'final' });
        out.end(() => endResolve());
      }
    },
    async finish() {
      const [, _hex] = await Promise.all([endPromise, digest]);
      const diskDrainDoneAt = Date.now();
      await rename(tmpPath, finalPath);
      return { firstByteAt, lastByteAt, diskDrainDoneAt, hashDoneAt: diskDrainDoneAt, renameDoneAt: Date.now() };
    },
  };
}

/**
 * Mode "writestream-hashbatched": createWriteStream for disk (zero-copy slice),
 * 4 MiB batch buffer ONLY for the hash worker (one transferable postMessage
 * every 4 MiB). Best of both worlds.
 */
function createWriteStreamBatchedHashSink(receiverDir, hash, total) {
  const BATCH = 4 << 20;
  const finalPath = join(receiverDir, blockPath(hash));
  const tmpPath = `${finalPath}.tmp`;
  mkdirSync(dirname(finalPath), { recursive: true });
  const out = createWriteStream(tmpPath);
  const { worker, digest } = spawnHashWorkerInline();
  let received = 0, firstByteAt = null, lastByteAt = null;
  let endResolve = null;
  const endPromise = new Promise((r) => (endResolve = r));
  let batchBuf = new Uint8Array(BATCH);
  let batchUsed = 0;
  const flush = () => {
    if (batchUsed === 0) return;
    const send = batchUsed === BATCH ? batchBuf : batchBuf.subarray(0, batchUsed).slice();
    worker.postMessage({ type: 'chunk', buf: send.buffer }, [send.buffer]);
    batchBuf = new Uint8Array(BATCH);
    batchUsed = 0;
  };
  return {
    ingest(chunk) {
      if (received >= total) return;
      if (firstByteAt === null) firstByteAt = Date.now();
      const remaining = total - received;
      const usable = remaining < chunk.length ? remaining : chunk.length;
      const slice = usable === chunk.length ? chunk : chunk.subarray(0, usable);
      // Disk: zero-copy.
      out.write(slice);
      // Hash: batched memcpy.
      const space = BATCH - batchUsed;
      if (usable <= space) {
        batchBuf.set(slice, batchUsed);
        batchUsed += usable;
        if (batchUsed === BATCH) flush();
      } else {
        batchBuf.set(slice.subarray(0, space), batchUsed);
        batchUsed = BATCH;
        flush();
        batchBuf.set(slice.subarray(space), 0);
        batchUsed = usable - space;
      }
      received += usable;
      if (received >= total) {
        lastByteAt = Date.now();
        flush();
        worker.postMessage({ type: 'final' });
        out.end(() => endResolve());
      }
    },
    async finish() {
      await Promise.all([endPromise, digest]);
      const diskDrainDoneAt = Date.now();
      await rename(tmpPath, finalPath);
      return { firstByteAt, lastByteAt, diskDrainDoneAt, hashDoneAt: diskDrainDoneAt, renameDoneAt: Date.now() };
    },
  };
}

const sinkFor = (dir, hash, total) => {
  switch (MODE) {
    case 'batched-nocrypto':   return createBatchedNoCryptoSink(dir, hash, total);
    case 'writestream-nocrypto': return createWriteStreamSink(dir, hash, total);
    case 'writestream-hash':   return createWriteStreamHashSink(dir, hash, total);
    case 'writestream-hashbatched': return createWriteStreamBatchedHashSink(dir, hash, total);
    default:                   return createPassthroughSink(dir, hash, total);
  }
};

async function runOnce(i) {
  const base = join(tmpdir(), `nb-nc-${process.pid}-${i}`);
  const senderDir = join(base, 'sender');
  const receiverDir = join(base, 'receiver');
  mkdirSync(senderDir, { recursive: true });
  mkdirSync(receiverDir, { recursive: true });
  const hash = await writeSenderBlock(senderDir, SIZE);

  let doneResolve;
  const donePromise = new Promise((r) => (doneResolve = r));
  const server = createServer((socket) => {
    tuneTcp(socket);
    const sink = sinkFor(receiverDir, hash, SIZE);
    let headerSkipped = false, headerNeed = 0;
    let carry = Buffer.alloc(0);
    let chunks = 0, minC = Infinity, maxC = 0;
    socket.on('data', (chunk) => {
      if (!headerSkipped) {
        carry = Buffer.concat([carry, chunk]);
        if (carry.length < 4) return;
        if (headerNeed === 0) headerNeed = 4 + carry.readUInt32BE(0);
        if (carry.length < headerNeed) return;
        const body = carry.subarray(headerNeed);
        headerSkipped = true;
        if (body.length > 0) {
          chunks++; if (body.length < minC) minC = body.length; if (body.length > maxC) maxC = body.length;
          sink.ingest(body);
        }
        return;
      }
      chunks++; if (chunk.length < minC) minC = chunk.length; if (chunk.length > maxC) maxC = chunk.length;
      sink.ingest(chunk);
    });
    socket.on('end', async () => {
      const phases = await sink.finish();
      doneResolve({ phases, chunks, minC, maxC });
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
  const result = await donePromise;
  const t1 = Date.now();
  server.close();
  rmSync(base, { recursive: true, force: true });
  const p = result.phases;
  return {
    wire: p.lastByteAt - p.firstByteAt,
    drain: p.diskDrainDoneAt - p.lastByteAt,
    total: t1 - t0,
    pump: pump.pumpEndAt - pump.pumpBeginAt,
    chunks: result.chunks,
  };
}

function fmtMbps(ms, b) { const m = (b * 8) / ms / 1000; return m >= 1000 ? `${(m / 1000).toFixed(2)} Gb/s` : `${m.toFixed(0)} Mb/s`; }

(async () => {
  const label = SIZE >= 1 << 30 ? `${(SIZE / (1 << 30)).toFixed(2)} GiB` : `${(SIZE / (1 << 20)).toFixed(0)} MiB`;
  console.log(`bench-direct-nocrypto: ${label}, ${RUNS} runs, mode=${MODE}\n`);
  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    try {
      const r = await runOnce(i);
      runs.push(r);
      console.log(`run ${i}: pump=${r.pump}ms wire=${r.wire}ms drain=${r.drain}ms total=${r.total}ms (${fmtMbps(r.total, SIZE)})`);
    } catch (e) { console.error(`run ${i} failed: ${e.message}`); }
  }
  if (runs.length === 0) process.exit(1);
  const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const wm = med(runs.map((r) => r.wire));
  const dm = med(runs.map((r) => r.drain));
  const tm = med(runs.map((r) => r.total));
  console.log(`\nmedian wire=${wm}ms drain=${dm}ms total=${tm}ms throughput=${fmtMbps(tm, SIZE)}`);
})();
