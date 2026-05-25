/**
 * Long-lived nearbytes alice/bob pair driver.
 *
 *   const pair = await NearbytesPair.startLocal(base);
 *   await pair.measure({ files, burst });   // → { wallMs, perStream, ...}
 *   await pair.measure(...);                 // re-use the warm pair
 *   await pair.stop();
 *
 * The pair pays one-time setup (boot + friend-session attach) at start,
 * then every `measure()` is just the data path. Each measurement does:
 *   1. tell bob to expect the file set
 *   2. tell alice to publish (or burst)
 *   3. wait for both replies
 *   4. compute wallMs = (last receivedMs) on bob from the publish-start
 *      reference time, matching the bulk-recv-phases activity log markers
 *
 * Output:
 *   {
 *     wallMs:        ms from publish start to last byte received,
 *     publishMs:     alice's local publish-call wall time,
 *     perStream:     [{ bytes, wireMs, drainMs, hashMs, renameMs }]
 *     bobReceiveMs:  per-file receivedMs as observed by bob,
 *   }
 */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { REMOTE_NODE_BIN } from './deploy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(HERE)));
const PEER_BIN = join(REPO_ROOT, 'dist/scripts/network-peer.js');

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
      /* already closed */
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
  child.stderr.on('data', (c) => (stderr += c.toString()));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${role}] exited ${code}; stderr tail:\n${stderr.slice(-400)}`);
    }
  });
  return new PeerHandle(role, child);
}

/**
 * Spawn a network-peer.js on a remote host via SSH. The remote process
 * runs in `${workdir}/nearbytes-benchmarks/` and reads commands from
 * stdin / writes responses to stdout — identical wire protocol to the
 * local spawn. SSH multiplexes both streams.
 *
 * Discovery defaults to "all" — `nearbytes-sync` always wires mDNS in,
 * and `all` adds Hyperswarm DHT on top as a fallback. On the same LAN
 * mDNS wins the race and the resulting TCP connection is direct over
 * LAN; the DHT only kicks in if multicast is filtered (e.g. WAN, or
 * mDNS-blocking switches).
 */
function spawnRemotePeer(role, host, { discovery = 'all', friendMs = 90000 } = {}) {
  const peerBase = `${host.workdir}/peer-${role}`;
  const nbDir = `${host.workdir}/nearbytes-benchmarks`;
  const peerBin = `${nbDir}/dist/scripts/network-peer.js`;
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
  // Pass the entire command as a SINGLE argv element. SSH joins
  // multiple trailing args with spaces, which breaks `bash -lc 'A && B'`
  // (the && would run in the outer shell, not the -c subshell).
  const child = spawn('ssh', [
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    host.ssh,
    remoteCmd,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));
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

export class NearbytesPair {
  constructor(alice, bob, base) {
    this.alice = alice;
    this.bob = bob;
    this.base = base;
    this.nextId = 1;
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
    return Object.assign(new NearbytesPair(alice, bob, base), {
      friendMs: { alice: aliceReady.friendSessionMs, bob: bobReady.friendSessionMs },
    });
  }

  /**
   * Start alice on aliceHost and bob on bobHost over SSH. Nearbytes data
   * flows directly between the two remotes (Mac is only a control plane:
   * it sees JSON commands + responses, not block traffic).
   *
   * `discovery` defaults to "hyperswarm" so the pair works across subnets.
   * For pure same-VLAN LAN tests, pass `discovery: "mdns"` to keep the
   * data path strictly on the LAN with zero DHT involvement.
   */
  static async startRemote(aliceHost, bobHost, { discovery = 'all', readyTimeoutMs = 120000, friendMs = 90000 } = {}) {
    const bob = spawnRemotePeer('bob', bobHost, { discovery, friendMs });
    await new Promise((r) => setTimeout(r, 500));
    const alice = spawnRemotePeer('alice', aliceHost, { discovery, friendMs });
    const [aliceReady, bobReady] = await Promise.all([
      withTimeout(alice.ready(), readyTimeoutMs, `alice@${aliceHost.ssh} ready`),
      withTimeout(bob.ready(), readyTimeoutMs, `bob@${bobHost.ssh} ready`),
    ]);
    return Object.assign(new NearbytesPair(alice, bob, null), {
      friendMs: { alice: aliceReady.friendSessionMs, bob: bobReady.friendSessionMs },
      hosts: { alice: aliceHost, bob: bobHost },
    });
  }

  /**
   * Hybrid pair: alice runs locally on this Mac, bob runs remotely over
   * SSH. The data path goes over the actual WAN between the two — no
   * netem, no Docker, no simulation. Discovery defaults to "all" so the
   * pair finds each other via hyperswarm DHT (mDNS multicast doesn't
   * cross internet routers).
   */
  static async startHybrid(aliceBase, bobHost, { discovery = 'all', readyTimeoutMs = 180000, friendMs = 120000 } = {}) {
    await rm(aliceBase, { recursive: true, force: true });
    await mkdir(aliceBase, { recursive: true });
    const bob = spawnRemotePeer('bob', bobHost, { discovery, friendMs });
    await new Promise((r) => setTimeout(r, 500));
    const alice = spawnPeer('alice', aliceBase, { discovery, friendMs });
    const [aliceReady, bobReady] = await Promise.all([
      withTimeout(alice.ready(), readyTimeoutMs, `alice (local) ready`),
      withTimeout(bob.ready(), readyTimeoutMs, `bob@${bobHost.ssh} ready`),
    ]);
    return Object.assign(new NearbytesPair(alice, bob, aliceBase), {
      friendMs: { alice: aliceReady.friendSessionMs, bob: bobReady.friendSessionMs },
      hosts: { alice: null, bob: bobHost },
    });
  }

  async measure({ files, burst, timeoutMs = 60000 }) {
    const id = this.nextId++;
    const tag = `m${id}`;
    const named = files.map((f, i) => ({
      name: `${tag}-${i}.bin`,
      bytes: f.bytes,
      seed: id * 1000 + i,
    }));
    // Tell bob to expect first so it has watchers primed when alice publishes.
    const expectP = this.bob.send({ cmd: 'expect', id, files: named, timeoutMs });
    // Tiny yield so the expect lands before publish (orderly logs).
    await new Promise((r) => setImmediate(r));
    const publishStart = Date.now();
    const publishP = this.alice.send({ cmd: 'publish', id, files: named, burst: !!burst });

    const [publish, expect] = await Promise.all([
      withTimeout(publishP, timeoutMs, `alice publish #${id}`),
      withTimeout(expectP, timeoutMs, `bob expect #${id}`),
    ]);

    const lastRecvMs = Math.max(...expect.files.map((f) => f.receivedMs));
    const wallMs = lastRecvMs;
    const perStream = (expect.bulkRecvMarkers ?? []).map((m) => {
      const fields = m.fields ?? {};
      const first = Number(fields.firstByteAt ?? 0);
      const last = Number(fields.lastByteAt ?? 0);
      const drain = Number(fields.diskDrainDoneAt ?? last);
      const hashD = Number(fields.hashDoneAt ?? drain);
      const rename = Number(fields.renameDoneAt ?? hashD);
      return {
        bytes: Number(fields.bytes ?? 0),
        wireMs: last - first,
        drainMs: drain - last,
        hashMs: hashD - drain,
        renameMs: rename - hashD,
      };
    });
    return {
      wallMs,
      bobReceiveMs: expect.files.map((f) => ({ name: f.name, bytes: f.bytes, receivedMs: f.receivedMs })),
      publishWallMs: publish.totalWallMs,
      publishStartAt: publishStart,
      perStream,
      matched: perStream.length,
      expected: files.length,
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

export async function ensurePeerBuilt() {
  if (!existsSync(PEER_BIN)) {
    throw new Error(`${PEER_BIN} missing — run "yarn build" in nearbytes-benchmarks first.`);
  }
}
