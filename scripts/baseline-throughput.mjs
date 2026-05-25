#!/usr/bin/env node
/**
 * Localhost throughput baselines (128 MiB by default):
 *   1. Node TCP pump, server discards bytes (pure wire)
 *   2. Node TCP pump, server writes bytes to a file via createWriteStream (wire + disk)
 *   3. `cp` localhost (filesystem copy; APFS may use clonefile)
 *   4. `dd` localhost (forced byte copy, bs=16M)
 *
 *   node scripts/baseline-throughput.mjs [bytes]
 */

import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import {
  createWriteStream,
  mkdtempSync,
  openSync,
  readSync,
  closeSync,
  writeSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIZE = Number(process.argv[2] ?? 128 * 1024 * 1024);
const SLICE = 16 * 1024 * 1024;
const PORT = 28778;

const tmp = mkdtempSync(join(tmpdir(), 'nb-baseline-'));
const srcPath = join(tmp, 'src.bin');
const dstFile = join(tmp, 'dst.bin');
const cpDst = join(tmp, 'cp-dst.bin');
const ddDst = join(tmp, 'dd-dst.bin');

function writeDeterministicSource(path, size) {
  const fd = openSync(path, 'w');
  const slice = 16 * 1024 * 1024;
  const buf = Buffer.allocUnsafe(slice);
  for (let i = 0; i < slice; i++) buf[i] = i & 0xff;
  let written = 0;
  while (written < size) {
    const need = Math.min(slice, size - written);
    writeSync(fd, buf, 0, need, written);
    written += need;
  }
  closeSync(fd);
}

function fmt(bytes, ms) {
  if (!ms || ms <= 0) return 'n/a';
  const mbps = (bytes * 8) / ms / 1000;
  return mbps >= 1000 ? `${(mbps / 1000).toFixed(2)} Gb/s` : `${mbps.toFixed(0)} Mb/s`;
}

function writeDrain(socket, chunk) {
  return new Promise((resolve, reject) => {
    const ok = socket.write(chunk, (err) => err && reject(err));
    if (ok) resolve();
    else socket.once('drain', resolve).once('error', reject);
  });
}

async function pumpFromFile(socket, path, size) {
  const fd = openSync(path, 'r');
  const buf = Buffer.allocUnsafe(SLICE);
  let sent = 0;
  while (sent < size) {
    const need = Math.min(SLICE, size - sent);
    readSync(fd, buf, 0, need, sent);
    await writeDrain(socket, buf.subarray(0, need));
    sent += need;
  }
  closeSync(fd);
}

function runNcLikeServer({ writeToDisk }) {
  return new Promise((resolve, reject) => {
    let received = 0;
    let firstByteAt = null;
    let lastByteAt = null;
    let diskDrainAt = null;
    const server = createServer((socket) => {
      socket.setNoDelay(true);
      const out = writeToDisk ? createWriteStream(dstFile) : null;
      socket.on('data', (chunk) => {
        if (firstByteAt === null) firstByteAt = Date.now();
        received += chunk.length;
        if (out) out.write(chunk);
        if (received >= SIZE) lastByteAt = Date.now();
      });
      socket.on('end', () => {
        const finalize = () => {
          diskDrainAt = Date.now();
          server.close(() => resolve({
            received,
            firstByteAt,
            lastByteAt,
            diskDrainAt,
          }));
        };
        if (out) out.end(finalize); else finalize();
      });
      socket.on('error', reject);
    });
    server.listen(PORT, '127.0.0.1', async () => {
      try {
        const client = connect({ port: PORT, host: '127.0.0.1' });
        client.setNoDelay(true);
        client.on('connect', async () => {
          try {
            await pumpFromFile(client, srcPath, SIZE);
            client.end();
          } catch (e) { reject(e); }
        });
        client.on('error', reject);
      } catch (e) { reject(e); }
    });
    server.on('error', reject);
  });
}

function timeSubprocess(cmd, args) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('exit', (code) => {
      if (code === 0) resolve(Date.now() - t0);
      else reject(new Error(`${cmd} exited ${code}: ${stderr}`));
    });
  });
}

function dropCacheHint(path) {
  // Best-effort: cat the file to /dev/null so subsequent reads come from page cache; nothing we can do to drop cache without sudo
  // Intentionally no-op; we just note that the source is warm.
  return path;
}

async function main() {
  console.log(`Source ${SIZE} bytes (${(SIZE / 1024 / 1024).toFixed(1)} MiB) at ${srcPath}`);
  writeDeterministicSource(srcPath, SIZE);
  dropCacheHint(srcPath);
  const srcStat = statSync(srcPath);
  if (srcStat.size !== SIZE) throw new Error('source size mismatch');

  console.log('\n=== Baselines (each is wall-clock end-to-end) ===\n');

  // 1) TCP pump, server discards
  {
    const r = await runNcLikeServer({ writeToDisk: false });
    const wire = r.lastByteAt - r.firstByteAt;
    console.log(`TCP loopback, server discards`.padEnd(40), `${wire} ms`.padStart(8), '  ', fmt(r.received, wire).padStart(12));
  }
  await new Promise((r) => setTimeout(r, 200));

  // 2) TCP pump, server writes to disk
  {
    const r = await runNcLikeServer({ writeToDisk: true });
    const wire = r.lastByteAt - r.firstByteAt;
    const drain = r.diskDrainAt - r.lastByteAt;
    const total = r.diskDrainAt - r.firstByteAt;
    console.log(
      `TCP loopback, server→file`.padEnd(40),
      `${total} ms`.padStart(8),
      '  ',
      fmt(r.received, total).padStart(12),
      `  (wire ${wire}ms ${fmt(r.received, wire)}, drain ${drain}ms ${fmt(r.received, drain)})`,
    );
  }

  // 3) cp localhost
  try { unlinkSync(cpDst); } catch {}
  {
    const ms = await timeSubprocess('cp', [srcPath, cpDst]);
    console.log(`cp ${srcPath.split('/').pop()} → cp-dst.bin`.padEnd(40), `${ms} ms`.padStart(8), '  ', fmt(SIZE, ms).padStart(12));
  }

  // 4) dd localhost
  try { unlinkSync(ddDst); } catch {}
  {
    const ms = await timeSubprocess('dd', [`if=${srcPath}`, `of=${ddDst}`, 'bs=16M']);
    console.log(`dd if=src of=dd-dst bs=16M`.padEnd(40), `${ms} ms`.padStart(8), '  ', fmt(SIZE, ms).padStart(12));
  }

  console.log('');
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); },
);
