/**
 * Long-lived protocol-peer driver (local + remote SSH).
 */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { REMOTE_NODE_BIN } from '../../network-bench/lib/deploy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(HERE)));
const PEER_BIN = join(REPO_ROOT, 'dist/scripts/protocol-peer.js');

class PeerHandle {
  constructor(role, child) {
    this.role = role;
    this.child = child;
    this.pending = new Map();
    this.readyP = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.event === 'ready') {
        this.resolveReady(msg);
        return;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.ok) resolve(msg);
        else reject(new Error(`${role}: ${msg.error}`));
      }
    });
  }

  async ready() {
    return this.readyP;
  }

  send(cmd) {
    return new Promise((resolve, reject) => {
      this.pending.set(cmd.id, { resolve, reject });
      this.child.stdin.write(JSON.stringify(cmd) + '\n');
    });
  }

  async exit() {
    try {
      this.child.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n');
    } catch {
      /* closed */
    }
    await new Promise((resolve) => {
      this.child.once('exit', resolve);
      setTimeout(() => {
        try {
          this.child.kill('SIGKILL');
        } catch {}
        resolve();
      }, 3000);
    });
  }
}

function spawnPeer(role, peerBase, { discovery = 'mdns', friendMs = 15000 } = {}) {
  if (!existsSync(PEER_BIN)) {
    throw new Error(`${PEER_BIN} missing — run "yarn build" first.`);
  }
  const env = {
    ...process.env,
    NEARBYTES_PEER_ROLE: role,
    NEARBYTES_PEER_BASE: peerBase,
    NEARBYTES_SYNC_DISCOVERY: discovery,
    NEARBYTES_PEER_FRIEND_MS: String(friendMs),
  };
  const child = spawn(process.execPath, [PEER_BIN], {
    cwd: REPO_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    const text = c.toString();
    stderr += text;
    if (process.env.NEARBYTES_PROTOCOL_PEER_STDERR === '1') {
      process.stderr.write(`[${role}] ${text}`);
    }
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${role}] exited ${code}; stderr tail:\n${stderr.slice(-400)}`);
    }
  });
  return new PeerHandle(role, child);
}

function spawnRemotePeer(role, host, { discovery = 'all', friendMs = 90000 } = {}) {
  const peerBase = `${host.workdir}/protocol-peer-${role}`;
  const nbDir = `${host.workdir}/nearbytes-benchmarks`;
  const peerBin = `${nbDir}/dist/scripts/protocol-peer.js`;
  const nodeBin = REMOTE_NODE_BIN(host.workdir);
  const remoteCmd = [
    `mkdir -p ${shq(peerBase)} ${shq(host.workdir + '/tmp')}`,
    `cd ${shq(nbDir)}`,
    `exec env ` +
      `NEARBYTES_PEER_ROLE=${role} ` +
      `NEARBYTES_PEER_BASE=${shq(peerBase)} ` +
      `NEARBYTES_SYNC_DISCOVERY=${discovery} ` +
      `NEARBYTES_PEER_FRIEND_MS=${friendMs} ` +
      `TMPDIR=${shq(host.workdir + '/tmp')} ` +
      `${shq(nodeBin)} ${shq(peerBin)}`,
  ].join(' && ');
  const child = spawn('ssh', [
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    host.ssh,
    remoteCmd,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => {
    const text = c.toString();
    stderr += text;
    if (process.env.NEARBYTES_PROTOCOL_PEER_STDERR === '1') {
      process.stderr.write(`[${role}@${host.ssh}] ${text}`);
    }
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[${role}@${host.ssh}] exited ${code}; stderr tail:\n${stderr.slice(-600)}\n`);
    }
  });
  return new PeerHandle(role, child);
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export class ProtocolPair {
  constructor(alice, bob) {
    this.alice = alice;
    this.bob = bob;
    this.nextId = 1;
    this.chatTotal = 0;
  }

  static async startLocal(base) {
    await rm(base, { recursive: true, force: true });
    await mkdir(base, { recursive: true });
    const bob = spawnPeer('bob', base);
    await new Promise((r) => setTimeout(r, 200));
    const alice = spawnPeer('alice', base);
    const [aliceReady, bobReady] = await Promise.all([
      withTimeout(alice.ready(), 30000, 'alice ready'),
      withTimeout(bob.ready(), 30000, 'bob ready'),
    ]);
    return Object.assign(new ProtocolPair(alice, bob), {
      friendMs: { alice: aliceReady.friendSessionMs, bob: bobReady.friendSessionMs },
    });
  }

  static async startRemote(aliceHost, bobHost, { discovery = 'all', readyTimeoutMs = 180000, friendMs = 90000 } = {}) {
    const bob = spawnRemotePeer('bob', bobHost, { discovery, friendMs });
    await new Promise((r) => setTimeout(r, 500));
    const alice = spawnRemotePeer('alice', aliceHost, { discovery, friendMs });
    const [aliceReady, bobReady] = await Promise.all([
      withTimeout(alice.ready(), readyTimeoutMs, `alice@${aliceHost.ssh} ready`),
      withTimeout(bob.ready(), readyTimeoutMs, `bob@${bobHost.ssh} ready`),
    ]);
    return Object.assign(new ProtocolPair(alice, bob), {
      friendMs: { alice: aliceReady.friendSessionMs, bob: bobReady.friendSessionMs },
      hosts: { alice: aliceHost, bob: bobHost },
    });
  }

  static async startHybrid(base, bobHost, { discovery = 'all', readyTimeoutMs = 180000, friendMs = 90000 } = {}) {
    await rm(base, { recursive: true, force: true });
    await mkdir(base, { recursive: true });
    const bob = spawnRemotePeer('bob', bobHost, { discovery, friendMs });
    await new Promise((r) => setTimeout(r, 500));
    const alice = spawnPeer('alice', base, { discovery, friendMs });
    const [aliceReady, bobReady] = await Promise.all([
      withTimeout(alice.ready(), readyTimeoutMs, 'alice ready'),
      withTimeout(bob.ready(), readyTimeoutMs, `bob@${bobHost.ssh} ready`),
    ]);
    return Object.assign(new ProtocolPair(alice, bob), {
      friendMs: { alice: aliceReady.friendSessionMs, bob: bobReady.friendSessionMs },
      hosts: { alice: null, bob: bobHost },
    });
  }

  async publishChatBatch(count, bodyLen, timeoutMs) {
    const id = this.nextId++;
    const delta = count - this.chatTotal;
    if (delta <= 0) {
      return { targetCount: count, delta: 0, wallMs: 0, skipped: true };
    }
    const expectP = this.bob.send({ cmd: 'expectChat', id, count: delta, timeoutMs });
    await new Promise((r) => setImmediate(r));
    const publishP = this.alice.send({ cmd: 'publishChat', id, count: delta, bodyLen });
    const [publish, expect] = await Promise.all([
      withTimeout(publishP, timeoutMs, `publishChat #${id}`),
      withTimeout(expectP, timeoutMs, `expectChat #${id}`),
    ]);
    this.chatTotal = count;
    return {
      targetCount: count,
      delta,
      wallMs: expect.wallMs,
      publishWallMs: publish.totalWallMs,
      perMessageMs: publish.perMessageMs,
      amortizedMs: expect.wallMs / delta,
    };
  }

  async measureFiles({ files, timeoutMs, burst = false }) {
    const id = this.nextId++;
    const named = files.map((f, i) => ({
      name: `proto-${id}-${i}.bin`,
      bytes: f.bytes,
      seed: id * 1000 + i,
    }));
    const expectP = this.bob.send({ cmd: 'expect', id, files: named, timeoutMs });
    await new Promise((r) => setImmediate(r));
    const publishP = this.alice.send({ cmd: 'publish', id, files: named, burst: !!burst });
    const [publish, expect] = await Promise.all([
      withTimeout(publishP, timeoutMs, `publish files #${id}`),
      withTimeout(expectP, timeoutMs, `expect files #${id}`),
    ]);
    const lastRecv = Math.max(...expect.files.map((f) => f.receivedMs));
    const bytes = files.reduce((a, f) => a + f.bytes, 0);
    return {
      wallMs: lastRecv,
      bytes,
      count: files.length,
      publishWallMs: publish.totalWallMs,
      goodputMbps: bytes > 0 && lastRecv > 0 ? Number(((bytes * 8) / lastRecv / 1000).toFixed(2)) : 0,
    };
  }

  async replay({ stale = true, timeoutMs = 120000, chatOnly = false }) {
    const id = this.nextId++;
    const r = await withTimeout(
      this.bob.send({ cmd: 'replay', id, stale, chatOnly }),
      timeoutMs,
      'replay',
    );
    return {
      chatReplayMs: r.chatReplayMs,
      fileReplayMs: r.fileReplayMs,
      chatCount: r.chatCount,
      fileCount: r.fileCount,
      stale: r.stale,
      engineChat: r.engineChat,
    };
  }

  async stop() {
    await Promise.all([this.alice.exit(), this.bob.exit()]);
  }
}

function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

export async function ensureProtocolPeerBuilt() {
  if (!existsSync(PEER_BIN)) {
    throw new Error(`${PEER_BIN} missing — run "yarn build" in nearbytes-benchmarks first.`);
  }
}
