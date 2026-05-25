#!/usr/bin/env node
/**
 * Microbenchmark mirroring the Nearbytes receiver hot path without the full sync stack.
 *
 *   node scripts/microbench-receiver.mjs <variant>
 *
 * Variants:
 *   nc-like        : socket -> writeSync (no hash)
 *   nc-like-async  : socket -> async parallel pwrite (no hash)
 *   batched-hash   : socket -> writeSync + 1 MiB hash batch -> worker
 *   batched-async  : socket -> async pwrite + 1 MiB hash batch -> worker
 *   inline-hash    : socket -> writeSync + main-thread sha256
 */

import { createServer, connect } from 'node:net';
import { closeSync, openSync, writeSync, close, open, write, createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';

const SIZE = 134217728;
const variant = process.argv[2] ?? 'batched-async';
const RUNS = 10;

function makePayload() {
  const buf = Buffer.allocUnsafe(SIZE);
  for (let i = 0; i < SIZE; i++) buf[i] = i & 0xff;
  return buf;
}

const PAYLOAD = makePayload();

function tuneTcp(s) {
  s.setNoDelay(true);
  try {
    s.setSendBufferSize?.(16 << 20);
    s.setReceiveBufferSize?.(16 << 20);
  } catch {}
}

function openAsync(path) {
  return new Promise((res, rej) => open(path, 'w', (e, fd) => (e ? rej(e) : res(fd))));
}
function writeAsync(fd, buf, len, pos) {
  return new Promise((res, rej) => write(fd, buf, 0, len, pos, (e) => (e ? rej(e) : res())));
}
function closeAsyncFd(fd) {
  return new Promise((res, rej) => close(fd, (e) => (e ? rej(e) : res())));
}

const WORKER_SRC = `
  const { createHash } = require('node:crypto');
  const { parentPort } = require('node:worker_threads');
  const h = createHash('sha256');
  parentPort.on('message', (msg) => {
    if (msg.type === 'chunk') { h.update(Buffer.from(msg.buf)); return; }
    if (msg.type === 'final') { parentPort.postMessage({ digest: h.digest('hex') }); parentPort.close(); }
  });
`;
function spawnHashWorker() {
  const worker = new Worker(WORKER_SRC, { eval: true });
  const digest = new Promise((res, rej) => {
    worker.once('message', (m) => res(m.digest));
    worker.once('error', rej);
  });
  return { worker, digest };
}

async function runOnce() {
  const tmp = join(tmpdir(), `micro-${process.pid}-${Date.now()}.bin`);
  let server;
  const serverReady = new Promise((res) => {
    server = createServer((s) => {
      tuneTcp(s);
      onConnection(s, tmp).then(res);
    });
    server.listen(0, '127.0.0.1');
  });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;

  const start = Date.now();
  const client = connect(port, '127.0.0.1');
  await new Promise((res) => client.once('connect', res));
  tuneTcp(client);
  // Single big write; let kernel buffer; rely on backpressure
  let off = 0;
  while (off < PAYLOAD.length) {
    const slice = PAYLOAD.subarray(off, Math.min(off + (16 << 20), PAYLOAD.length));
    if (!client.write(slice)) {
      await new Promise((r) => client.once('drain', r));
    }
    off += slice.length;
  }
  client.end();
  const result = await serverReady;
  const end = Date.now();
  server.close();
  await unlink(tmp).catch(() => {});
  return { wallMs: end - start, ...result };
}

async function onConnection(socket, tmpPath) {
  if (variant === 'nc-like') {
    const fd = openSync(tmpPath, 'w');
    let received = 0;
    let firstByte = 0;
    return await new Promise((resolve) => {
      socket.on('data', (buf) => {
        if (firstByte === 0) firstByte = Date.now();
        writeSync(fd, buf, 0, buf.length);
        received += buf.length;
      });
      socket.on('end', () => {
        const lastByte = Date.now();
        closeSync(fd);
        resolve({ received, wireMs: lastByte - firstByte, drainMs: 0, hashMs: 0 });
      });
    });
  }

  if (variant === 'nc-like-async') {
    const fdPromise = openAsync(tmpPath);
    let received = 0;
    let inflight = 0;
    let firstByte = 0;
    let lastByte = 0;
    let drainDone = 0;
    return await new Promise((resolve) => {
      let endResolve = null;
      const tryFinish = async () => {
        if (lastByte && inflight === 0 && !drainDone) {
          drainDone = Date.now();
          const fd = await fdPromise;
          await closeAsyncFd(fd);
          if (endResolve) endResolve();
        }
      };
      socket.on('data', (buf) => {
        if (firstByte === 0) firstByte = Date.now();
        const pos = received;
        received += buf.length;
        const slice = buf;
        inflight++;
        void (async () => {
          const fd = await fdPromise;
          await writeAsync(fd, slice, slice.length, pos);
          inflight--;
          if (lastByte) tryFinish();
        })();
      });
      socket.on('end', () => {
        lastByte = Date.now();
        new Promise((r) => (endResolve = r)).then(() =>
          resolve({ received, wireMs: lastByte - firstByte, drainMs: drainDone - lastByte, hashMs: 0 }),
        );
        tryFinish();
      });
    });
  }

  if (variant === 'batched-async') {
    const fdPromise = openAsync(tmpPath);
    const { worker, digest } = spawnHashWorker();
    const BATCH = 1 << 20;
    let batch = new Uint8Array(BATCH);
    let used = 0;
    const flush = () => {
      if (used === 0) return;
      const send = batch.byteLength === used ? batch : batch.subarray(0, used).slice();
      worker.postMessage({ type: 'chunk', buf: send.buffer }, [send.buffer]);
      batch = new Uint8Array(BATCH);
      used = 0;
    };
    const push = (s) => {
      let off = 0;
      while (off < s.byteLength) {
        const space = batch.byteLength - used;
        const take = Math.min(space, s.byteLength - off);
        batch.set(s.subarray(off, off + take), used);
        used += take;
        off += take;
        if (used === batch.byteLength) flush();
      }
    };
    let received = 0;
    let inflight = 0;
    let firstByte = 0;
    let lastByte = 0;
    let drainDone = 0;
    let hashDone = 0;
    return await new Promise((resolve) => {
      let endResolve = null;
      const tryFinish = async () => {
        if (lastByte && inflight === 0 && !drainDone) {
          drainDone = Date.now();
          const fd = await fdPromise;
          await closeAsyncFd(fd);
          await digest;
          hashDone = Date.now();
          if (endResolve) endResolve();
        }
      };
      socket.on('data', (buf) => {
        if (firstByte === 0) firstByte = Date.now();
        const pos = received;
        received += buf.length;
        push(buf);
        inflight++;
        void (async () => {
          const fd = await fdPromise;
          await writeAsync(fd, buf, buf.length, pos);
          inflight--;
          if (lastByte) tryFinish();
        })();
      });
      socket.on('end', () => {
        lastByte = Date.now();
        flush();
        worker.postMessage({ type: 'final' });
        new Promise((r) => (endResolve = r)).then(() =>
          resolve({
            received,
            wireMs: lastByte - firstByte,
            drainMs: drainDone - lastByte,
            hashMs: hashDone - drainDone,
          }),
        );
        tryFinish();
      });
    });
  }

  if (variant === 'batched-sync') {
    const fd = openSync(tmpPath, 'w');
    const { worker, digest } = spawnHashWorker();
    const BATCH = 1 << 20;
    let batch = new Uint8Array(BATCH);
    let used = 0;
    const flush = () => {
      if (used === 0) return;
      const send = batch.byteLength === used ? batch : batch.subarray(0, used).slice();
      worker.postMessage({ type: 'chunk', buf: send.buffer }, [send.buffer]);
      batch = new Uint8Array(BATCH);
      used = 0;
    };
    const push = (s) => {
      let off = 0;
      while (off < s.byteLength) {
        const space = batch.byteLength - used;
        const take = Math.min(space, s.byteLength - off);
        batch.set(s.subarray(off, off + take), used);
        used += take;
        off += take;
        if (used === batch.byteLength) flush();
      }
    };
    let received = 0;
    let firstByte = 0;
    let lastByte = 0;
    return await new Promise((resolve) => {
      socket.on('data', (buf) => {
        if (firstByte === 0) firstByte = Date.now();
        push(buf);
        writeSync(fd, buf, 0, buf.length);
        received += buf.length;
      });
      socket.on('end', async () => {
        lastByte = Date.now();
        closeSync(fd);
        flush();
        worker.postMessage({ type: 'final' });
        await digest;
        const hashDone = Date.now();
        resolve({ received, wireMs: lastByte - firstByte, drainMs: 0, hashMs: hashDone - lastByte });
      });
    });
  }

  if (variant === 'inline-hash') {
    const fd = openSync(tmpPath, 'w');
    const h = createHash('sha256');
    let received = 0;
    let firstByte = 0;
    return await new Promise((resolve) => {
      socket.on('data', (buf) => {
        if (firstByte === 0) firstByte = Date.now();
        h.update(buf);
        writeSync(fd, buf, 0, buf.length);
        received += buf.length;
      });
      socket.on('end', () => {
        const lastByte = Date.now();
        closeSync(fd);
        h.digest('hex');
        resolve({ received, wireMs: lastByte - firstByte, drainMs: 0, hashMs: 0 });
      });
    });
  }

  throw new Error(`unknown variant ${variant}`);
}

(async () => {
  console.log(`microbench-receiver variant=${variant} runs=${RUNS}`);
  for (let i = 1; i <= RUNS; i++) {
    const r = await runOnce();
    console.log(
      `run ${i}: wall=${r.wallMs}ms wire=${r.wireMs}ms drain=${r.drainMs}ms hash=${r.hashMs}ms`,
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
