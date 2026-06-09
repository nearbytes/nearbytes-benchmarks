/**
 * Long-lived protocol-peer driver (local + remote SSH).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { REMOTE_NODE_BIN } from '../../network-bench/lib/deploy.mjs';
import { optEnabled, optEnvShell } from '../../lib/optimization-flags.mjs';
import { buildPhaseTimeline } from '../../lib/phase-timeline.mjs';
import { summarizeSustainedSession, sustainedMinWallMs } from '../../lib/sustained-bench.mjs';
import { startResourceMonitor, summarize } from '../../network-bench/lib/resmon.mjs';

function overlapExpectEnabled() {
  return optEnabled('NEARBYTES_OPT_OVERLAP_EXPECT');
}

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
      }, 10000);
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

function spawnRemotePeer(role, host, { discovery = 'all', friendMs = 90000, sshExtra = [] } = {}) {
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
      `${optEnvShell()} ` +
      `${shq(nodeBin)} ${shq(peerBin)}`,
  ].join(' && ');
  const child = spawn('ssh', [
    '-o', 'ConnectTimeout=30',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=8',
    ...sshExtra,
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

  static async startLocal(base, { readyTimeoutMs = 180000, friendMs = 15000 } = {}) {
    await rm(base, { recursive: true, force: true });
    await mkdir(base, { recursive: true });
    const bob = spawnPeer('bob', base, { friendMs });
    await new Promise((r) => setTimeout(r, 200));
    const alice = spawnPeer('alice', base, { friendMs });
    const [aliceReady, bobReady] = await Promise.all([
      withTimeout(alice.ready(), readyTimeoutMs, 'alice ready'),
      withTimeout(bob.ready(), readyTimeoutMs, 'bob ready'),
    ]);
    return Object.assign(new ProtocolPair(alice, bob), {
      friendMs: { alice: aliceReady.friendSessionMs, bob: bobReady.friendSessionMs },
    });
  }

  static async startRemote(aliceHost, bobHost, { discovery = 'all', readyTimeoutMs = 180000, friendMs = 90000, staggerMs = 500, sshExtra = () => [] } = {}) {
    const bobExtra = typeof sshExtra === 'function' ? sshExtra(bobHost) : sshExtra;
    const bob = spawnRemotePeer('bob', bobHost, { discovery, friendMs, sshExtra: bobExtra });
    await new Promise((r) => setTimeout(r, staggerMs));
    const aliceExtra = typeof sshExtra === 'function' ? sshExtra(aliceHost) : sshExtra;
    const alice = spawnRemotePeer('alice', aliceHost, { discovery, friendMs, sshExtra: aliceExtra });
    const [aliceReady, bobReady] = await Promise.all([
      withTimeout(alice.ready(), readyTimeoutMs, `alice@${aliceHost.ssh} ready`),
      withTimeout(bob.ready(), readyTimeoutMs, `bob@${bobHost.ssh} ready`),
    ]);
    return Object.assign(new ProtocolPair(alice, bob), {
      friendMs: { alice: aliceReady.friendSessionMs, bob: bobReady.friendSessionMs },
      hosts: { alice: aliceHost, bob: bobHost },
    });
  }

  static async startHybrid(base, bobHost, { discovery = 'all', readyTimeoutMs = 180000, friendMs = 90000, sshExtra = [] } = {}) {
    await rm(base, { recursive: true, force: true });
    await mkdir(base, { recursive: true });
    const bobExtra = typeof sshExtra === 'function' ? sshExtra(bobHost) : sshExtra;
    const bob = spawnRemotePeer('bob', bobHost, { discovery, friendMs, sshExtra: bobExtra });
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

  async measureFiles({ files, timeoutMs, burst = false, caseTag = 'xfer' }) {
    const id = this.nextId++;
    const tag = String(caseTag).replace(/[^a-zA-Z0-9_-]/g, '_');
    const named = files.map((f, i) => ({
      name: `proto-${tag}-${id}-${i}.bin`,
      bytes: f.bytes,
      seed: id * 10000 + i,
    }));
    const resmon = process.env.NEARBYTES_BENCH_RESMON === '1';
    const monAlice =
      resmon && this.alice.child?.pid > 0 ? startResourceMonitor(this.alice.child.pid) : null;
    const monBob =
      resmon && this.bob.child?.pid > 0 ? startResourceMonitor(this.bob.child.pid) : null;
    let publish;
    let expect;
    const useOverlap = overlapExpectEnabled();
    if (useOverlap) {
      const expectP = this.bob.send({ cmd: 'expect', id, files: named, timeoutMs });
      await new Promise((r) => setImmediate(r));
      const publishP = this.alice.send({ cmd: 'publish', id, files: named, burst: !!burst });
      [publish, expect] = await Promise.all([
        withTimeout(publishP, timeoutMs, `publish files #${id}`),
        withTimeout(expectP, timeoutMs, `expect files #${id}`),
      ]);
    } else {
      const expectP = this.bob.send({ cmd: 'expect', id, files: named, timeoutMs });
      publish = await withTimeout(
        this.alice.send({ cmd: 'publish', id, files: named, burst: !!burst }),
        timeoutMs,
        `publish files #${id}`,
      );
      expect = await withTimeout(expectP, timeoutMs, `expect files #${id}`);
    }
    const lastRecv = Math.max(...expect.files.map((f) => f.receivedMs));
    const bytes = files.reduce((a, f) => a + f.bytes, 0);
    const [monAliceReport, monBobReport] = await Promise.all([
      monAlice?.stop().catch(() => null) ?? null,
      monBob?.stop().catch(() => null) ?? null,
    ]);
    const publishStartedAt = publish.publishStartedAt ?? Date.now() - publish.totalWallMs;
    const recvPhases = expect.files.map((f) => f.phases).filter(Boolean);
    const timeline = buildPhaseTimeline({
      publishStartedAt,
      publishWallMs: publish.totalWallMs,
      recvPhases,
    });
    return {
      wallMs: lastRecv,
      bytes,
      count: files.length,
      publishWallMs: publish.totalWallMs,
      publishStartedAt,
      goodputMbps: bytes > 0 && lastRecv > 0 ? Number(((bytes * 8) / lastRecv / 1000).toFixed(2)) : 0,
      timeline,
      encode: {
        publishCpuMs: publish.publishCpuMs,
        encodeRssBytesMax: publish.encodeRssBytesMax,
        monitor: monAliceReport ? summarize(monAliceReport) : null,
      },
      decode: {
        receiveCpuMs: expect.receiveCpuMs,
        decodeRssBytesMax: expect.decodeRssBytesMax,
        monitor: monBobReport ? summarize(monBobReport) : null,
      },
    };
  }

  /**
   * Loop transfers on this warm pair until accumulated wallMs ≥ minWallMs.
   * @param {{ files: { bytes: number }[], timeoutMs: number, burst?: boolean, caseTag?: string, minWallMs?: number, warmupTransfers?: number }} opts
   */
  async measureSustained({
    files,
    timeoutMs,
    burst = false,
    caseTag = 'sustained',
    minWallMs = sustainedMinWallMs(),
    warmupTransfers = 1,
  }) {
    const warmups = Math.max(0, warmupTransfers);
    for (let w = 0; w < warmups; w++) {
      await this.measureFiles({
        files,
        timeoutMs,
        burst,
        caseTag: `${caseTag}-warm${w}`,
      });
    }
    const transfers = [];
    let accumWallMs = 0;
    const pipeline = process.env.NEARBYTES_SUSTAINED_PUBLISH_PIPELINE === '1';
    if (!pipeline) {
      while (accumWallMs < minWallMs) {
        const r = await this.measureFiles({
          files,
          timeoutMs,
          burst,
          caseTag: `${caseTag}-${transfers.length}`,
        });
        transfers.push(r);
        accumWallMs += r.wallMs;
      }
      return { ...summarizeSustainedSession(transfers, minWallMs), runs: transfers };
    }

    let carryExpect = null;
    while (accumWallMs < minWallMs) {
      const id = this.nextId++;
      const tag = String(caseTag).replace(/[^a-zA-Z0-9_-]/g, '_');
      const named = files.map((f, i) => ({
        name: `proto-${tag}-${id}-${i}.bin`,
        bytes: f.bytes,
        seed: id * 10000 + i,
      }));
      const expectP = this.bob.send({ cmd: 'expect', id, files: named, timeoutMs });
      await new Promise((r) => setImmediate(r));
      const publishP = this.alice.send({ cmd: 'publish', id, files: named, burst: !!burst });
      if (carryExpect) {
        const r = await carryExpect;
        transfers.push(r);
        accumWallMs += r.wallMs;
        if (accumWallMs >= minWallMs) break;
      }
      carryExpect = this.finishPipelinedTransfer(publishP, expectP, named, files);
      await withTimeout(publishP, timeoutMs, `publish files #${id}`);
    }
    if (carryExpect) {
      const r = await carryExpect;
      transfers.push(r);
    }
    return { ...summarizeSustainedSession(transfers, minWallMs), runs: transfers, pipelined: true };
  }

  async finishPipelinedTransfer(publishP, expectP, named, files) {
    const [publish, expect] = await Promise.all([
      publishP,
      expectP,
    ]);
    const lastRecv = Math.max(...expect.files.map((f) => f.receivedMs));
    const bytes = files.reduce((a, f) => a + f.bytes, 0);
    const publishStartedAt = publish.publishStartedAt ?? Date.now() - publish.totalWallMs;
    const recvPhases = expect.files.map((f) => f.phases).filter(Boolean);
    const timeline = buildPhaseTimeline({
      publishStartedAt,
      publishWallMs: publish.totalWallMs,
      recvPhases,
    });
    return {
      wallMs: lastRecv,
      bytes,
      count: files.length,
      publishWallMs: publish.totalWallMs,
      publishStartedAt,
      goodputMbps: bytes > 0 && lastRecv > 0 ? Number(((bytes * 8) / lastRecv / 1000).toFixed(2)) : 0,
      timeline,
      encode: {
        publishCpuMs: publish.publishCpuMs,
        encodeRssBytesMax: publish.encodeRssBytesMax,
        monitor: null,
      },
      decode: {
        receiveCpuMs: expect.receiveCpuMs,
        decodeRssBytesMax: expect.decodeRssBytesMax,
        monitor: null,
      },
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

export function killStrayProtocolPeers() {
  spawnSync('pkill', ['-f', 'dist/scripts/protocol-peer.js'], { stdio: 'pipe' });
}

export async function ensureProtocolPeerBuilt() {
  if (!existsSync(PEER_BIN)) {
    throw new Error(`${PEER_BIN} missing — run "yarn build" in nearbytes-benchmarks first.`);
  }
}
