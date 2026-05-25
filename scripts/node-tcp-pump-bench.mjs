#!/usr/bin/env node
/**
 * Raw localhost TCP pump — same shape as nc (128 MiB), pure Node.
 *   node scripts/node-tcp-pump-bench.mjs server
 *   node scripts/node-tcp-pump-bench.mjs client
 */

import { createServer, connect } from 'net';
import { createReadStream } from 'fs';
import { openSync, readSync, closeSync } from 'fs';

const PORT = 28777;
const SIZE = 128 * 1024 * 1024;
const SLICE = 16 * 1024 * 1024;
const role = process.argv[2] ?? 'client';

function writeDrain(socket, chunk) {
  return new Promise((resolve, reject) => {
    const ok = socket.write(chunk, (err) => {
      if (err) reject(err);
    });
    if (ok) resolve();
    else socket.once('drain', resolve).once('error', reject);
  });
}

async function pumpBuffer(socket) {
  const fd = openSync('/dev/zero', 'r');
  const buf = Buffer.allocUnsafe(SLICE);
  let sent = 0;
  const t0 = performance.now();
  while (sent < SIZE) {
    const need = Math.min(SLICE, SIZE - sent);
    readSync(fd, buf, 0, need, null);
    await writeDrain(socket, buf.subarray(0, need));
    sent += need;
  }
  closeSync(fd);
  socket.end();
  const sec = (performance.now() - t0) / 1000;
  const mbps = (SIZE * 8) / sec / 1e6;
  console.log(`client: sent ${SIZE} B in ${sec.toFixed(3)}s → ${mbps.toFixed(0)} Mb/s`);
}

async function pumpReadStream(socket) {
  const t0 = performance.now();
  await new Promise((resolve, reject) => {
    const rs = createReadStream('/dev/zero', { highWaterMark: SLICE });
    let sent = 0;
    rs.on('data', async (chunk) => {
      rs.pause();
      try {
        const take = Math.min(chunk.length, SIZE - sent);
        await writeDrain(socket, chunk.subarray(0, take));
        sent += take;
        if (sent >= SIZE) {
          socket.end();
          rs.destroy();
          resolve();
        } else rs.resume();
      } catch (e) {
        reject(e);
      }
    });
    rs.on('error', reject);
  });
  const sec = (performance.now() - t0) / 1000;
  const mbps = (SIZE * 8) / sec / 1e6;
  console.log(`client(stream): sent ${SIZE} B in ${sec.toFixed(3)}s → ${mbps.toFixed(0)} Mb/s`);
}

if (role === 'server') {
  const server = createServer((socket) => {
    socket.setNoDelay(true);
    let got = 0;
    const t0 = performance.now();
    socket.on('data', (c) => {
      got += c.length;
    });
    socket.on('end', () => {
      const sec = (performance.now() - t0) / 1000;
      const mbps = (got * 8) / sec / 1e6;
      console.log(`server: recv ${got} B in ${sec.toFixed(3)}s → ${mbps.toFixed(0)} Mb/s`);
      process.exit(0);
    });
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`listen ${PORT}`));
} else {
  const socket = connect({ host: '127.0.0.1', port: PORT });
  socket.setNoDelay(true);
  socket.on('connect', async () => {
    await pumpBuffer(socket);
    process.exit(0);
  });
  socket.on('error', (e) => {
    console.error(e);
    process.exit(1);
  });
}
