#!/usr/bin/env node
/**
 * Transfer matrix — topology is fixed per category:
 *
 *   local — loopback peers on the orchestrator (nc/cat baselines)
 *   lan   — CNR alice ↔ CNR bob on the lab VLAN, mDNS discovery only (no DHT)
 *   wan   — Mac alice ↔ CNR bob over the public internet, DHT discovery only (no mDNS)
 *
 * LAN MUST NOT run with the Mac as a protocol peer. Orchestrate from the Mac via SSH
 * (both peers on pc-ciancia + fmt-5000), or run on pc-ciancia with --lan-alice-on-host.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { openSync, writeSync, closeSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureRemoteWorkspace } from '../network-bench/lib/deploy.mjs';
import { DEFAULT_BENCH_TARGET_MS } from '../lib/local-config.mjs';
import { resolveBenchRepeatBudget, shouldTakeAnotherBenchRep } from '../lib/bench-timing.mjs';
import { sustainedMinWallMs } from '../lib/sustained-bench.mjs';
import { aggregateTimelines } from '../lib/phase-timeline.mjs';
import { loadHosts, requireLan, requireWan } from '../network-bench/lib/hosts.mjs';
import {
  ensureAlicePayload,
  lanNc,
  lanRsync,
  lanScp,
  localCat,
  localCatSustained,
  localNc,
  localNcSustained,
  prepareRemoteDir,
  remoteRsync,
  totalBytes,
} from '../network-bench/lib/baselines.mjs';
import { shellQuote, sshRun, SshMaster } from '../network-bench/lib/remote.mjs';
import { aggregateNearbytesResources } from '../lib/aggregate-resources.mjs';
import { applyOptArgvToEnv } from '../lib/optimization-flags.mjs';
import { ProtocolPair, ensureProtocolPeerBuilt, killStrayProtocolPeers } from './lib/protocol-pair.mjs';

Object.assign(process.env, applyOptArgvToEnv());

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const MIB = 1024 * 1024;
const KIB = 1024;

/** LAN: same VLAN CNR hosts — mDNS/DNS-SD only. */
const LAN_DISCOVERY = 'mdns';
/** WAN: Mac ↔ CNR over the internet — Hyperswarm DHT only. */
const WAN_DISCOVERY = 'dht';

/** Reference baselines per topology (not nearbytes — that is always measured). */
const BASELINE_SYSTEMS = {
  local: ['nc', 'cat'],
  lan: ['nc', 'scp', 'rsync'],
  wan: ['scp', 'rsync'],
};

const SUSTAINED_MIN_WALL_MS = sustainedMinWallMs();

const MICRO_CASES = [
  { label: '64MiB_512KiB_x128_burst', count: 128, bytes: 512 * KIB, burst: true },
  { label: '64MiB_1MiB_x64_burst', count: 64, bytes: 1 * MIB, burst: true },
  { label: '64MiB_4MiB_x16_burst', count: 16, bytes: 4 * MIB, burst: true },
  { label: '64MiB_16MiB_x4_burst', count: 4, bytes: 16 * MIB, burst: true },
  { label: '128MiB_x1_seq', count: 1, bytes: 128 * MIB, burst: false },
];

/** Local default: ≥20 s accumulated wall per rep, 3 reps ≈ 60 s budget (solid stats, not micro). */
const SUSTAINED_CASES = [
  {
    label: '128MiB_sustained_20s',
    count: 1,
    bytes: 128 * MIB,
    burst: false,
    sustained: { minWallMs: SUSTAINED_MIN_WALL_MS, warmupTransfers: 1 },
  },
  {
    label: '4MiB_sustained_20s',
    count: 1,
    bytes: 4 * MIB,
    burst: false,
    sustained: { minWallMs: SUSTAINED_MIN_WALL_MS, warmupTransfers: 2 },
  },
  /** Same 64 MiB per batch as micro burst row; sustained ≥20 s wall so publish overlaps wire. */
  {
    label: '64MiB_4MiB_x16_burst_sustained_20s',
    count: 16,
    bytes: 4 * MIB,
    burst: true,
    sustained: { minWallMs: SUSTAINED_MIN_WALL_MS, warmupTransfers: 1 },
  },
  /** 128 MiB per batch (32×4 MiB parallel publish) — pipelined alternative to 128MiB_sustained_20s. */
  {
    label: '128MiB_4MiB_x32_burst_sustained_20s',
    count: 32,
    bytes: 4 * MIB,
    burst: true,
    sustained: { minWallMs: SUSTAINED_MIN_WALL_MS, warmupTransfers: 1 },
  },
];

const CASES = [...SUSTAINED_CASES, ...MICRO_CASES];

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const hasArg = (name) => process.argv.includes(name);
const categories = arg('--categories', 'local').split(',').map((s) => s.trim()).filter(Boolean);
const { targetMs, maxRepeats } = resolveBenchRepeatBudget({
  targetMs: arg('--target-ms', process.env.NEARBYTES_TRANSFER_TARGET_MS ?? String(DEFAULT_BENCH_TARGET_MS)),
  maxRepeats: arg('--max-repeats', process.env.NEARBYTES_TRANSFER_MAX_REPEATS ?? '8'),
  label: 'transfer-matrix',
});
const outPath = arg('--out', join(REPO_ROOT, '.local/bench/protocol/transfer-matrix-results.json'));
const skipDeploy = hasArg('--skip-deploy');
const nearbytesOnly = hasArg('--nearbytes-only');
const caseFilter = arg('--cases', '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * When set, the orchestrator process IS the LAN alice host (pc-ciancia): alice peer runs
 * locally on that machine, bob stays on fmt-5000. Still CNR↔CNR + mDNS — not Mac↔CNR.
 * Remote worker on pc-ciancia sets this; the Mac orchestrator MUST NOT.
 */
const lanAliceOnHost = hasArg('--lan-alice-on-host')
  || process.env.NEARBYTES_LAN_ALICE_ON_HOST === '1';

if (hasArg('--orchestrate-on') || process.env.NEARBYTES_TRANSFER_ORCHESTRATE) {
  throw new Error(
    '--orchestrate-on / NEARBYTES_TRANSFER_ORCHESTRATE is removed. ' +
      'LAN from Mac: yarn bench:protocol:transfer-matrix --categories lan (CNR↔CNR, mDNS). ' +
      'LAN on pc-ciancia: --lan-alice-on-host. WAN: --categories wan (Mac↔CNR, DHT).',
  );
}

const deployedCategories = new Set();
/** @type {SshMaster | null} */
let wanSshMaster = null;
/** @type {{ alice: SshMaster | null, bob: SshMaster | null }} */
let lanSshMasters = { alice: null, bob: null };

function log(msg) {
  const line = `[transfer-matrix ${new Date().toISOString()}] ${msg}`;
  process.stderr.write(`${line}\n`);
}

function mbps(bytes, ms) {
  return ms > 0 ? Number(((bytes * 8) / ms / 1000).toFixed(2)) : 0;
}

function topologyMeta(category, hosts) {
  if (category === 'local') {
    return {
      peers: 'loopback',
      alice: 'orchestrator-local',
      bob: 'orchestrator-local',
      discovery: 'mdns',
      orchestrator: 'mac',
    };
  }
  if (category === 'lan') {
    const lan = requireLan(hosts);
    return {
      peers: 'cnr-cnr',
      alice: `${lan.alice.label ?? lan.alice.ssh}@${lan.alice.ssh}`,
      bob: `${lan.bob.label ?? lan.bob.ssh}@${lan.bob.ssh}`,
      discovery: LAN_DISCOVERY,
      orchestrator: lanAliceOnHost ? lan.alice.ssh : 'mac-ssh',
      alicePeer: lanAliceOnHost ? 'local-on-alice-host' : 'remote-ssh',
      bobPeer: 'remote-ssh',
    };
  }
  const wan = requireWan(hosts);
  const bobSsh = process.env.NEARBYTES_PROTOCOL_WAN_BOB_SSH ?? wan.bob.ssh;
  return {
    peers: 'mac-cnr',
    alice: 'orchestrator-local',
    bob: `${wan.bob.label ?? bobSsh}@${bobSsh}`,
    discovery: WAN_DISCOVERY,
    orchestrator: 'mac',
    alicePeer: 'local-on-mac',
    bobPeer: 'remote-ssh',
  };
}

function makePayload(sizeBytes, seed) {
  if (sizeBytes <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(sizeBytes);
  const tile = Buffer.allocUnsafe(256);
  for (let i = 0; i < 256; i++) tile[i] = (i + seed) & 0xff;
  for (let off = 0; off < sizeBytes; off += 256) {
    tile.copy(buf, off, 0, Math.min(256, sizeBytes - off));
  }
  return buf;
}

/** WAN baseline timeout: at least 10 min, scale ~3 min per 64 MiB aggregate. */
function baselineTimeoutMs(plan) {
  const agg = plan.count * plan.bytes;
  return Math.max(600_000, Math.ceil(agg / (64 * MIB)) * 180_000);
}

/**
 * Nearbytes transfer timeout per topology.
 * LAN gigabit: 64 MiB should land in ~1s; fail fast if sync wedges (never 10 min).
 */
function nearbytesTimeoutMs(category, plan) {
  const totalMiB = (plan.count * plan.bytes) / MIB;
  if (category === 'lan') {
    const transferBudget = Math.ceil(totalMiB / 50) * 2000 + 5000;
    const burstSlack = plan.burst ? Math.min(25_000, plan.count * 120) : 0;
    return Math.min(60_000, Math.max(25_000, transferBudget + burstSlack));
  }
  if (category === 'local') {
    return Math.min(120_000, Math.max(30_000, totalMiB * 2000 + 15_000));
  }
  return Math.max(600_000, totalMiB * 8000);
}

async function sshPreflight(alias, { retries = 3 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      await sshRun(alias, 'echo ok', { timeoutMs: 30_000 });
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      log(`ssh preflight ${alias} attempt ${i + 1} failed — retry in 5s: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function runProc(cmd, args, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 240)}`));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function localScratch(category, label) {
  const p = join(tmpdir(), `nearbytes-transfer-${category}-${label}-${Date.now()}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function makeLocalFiles(plan, prefix, repeats = 1) {
  const dir = localScratch('payloads', prefix);
  const files = [];
  for (let r = 0; r < repeats; r++) {
    for (let i = 0; i < plan.count; i++) {
      const name = `${prefix}-r${r}-${i}.bin`;
      const path = join(dir, name);
      const fd = openSync(path, 'w');
      const buf = makePayload(plan.bytes, r * 1000 + i + 1);
      writeSync(fd, buf);
      closeSync(fd);
      files.push({ name, path, bytes: statSync(path).size });
    }
  }
  return { dir, files };
}

async function measureRepeated(system, plan, runOnce) {
  const runs = [];
  let totalMs = 0;
  let totalBytes = 0;
  while (shouldTakeAnotherBenchRep({ runs, totalMs, targetMs, maxRepeats })) {
    const r = await runOnce(runs.length);
    runs.push(r);
    totalMs += r.wallMs;
    totalBytes += r.bytes;
  }
  return {
    system,
    repeats: runs.length,
    wallMs: Math.round(totalMs),
    bytes: totalBytes,
    goodputMbps: mbps(totalBytes, totalMs),
    targetReached: totalMs >= targetMs,
    runs,
  };
}

async function cleanupLanPeers(lan, { alice = true, bob = true } = {}) {
  const jobs = [];
  if (bob) {
    jobs.push(
      sshRun(lan.bob.ssh, 'pkill -f "[p]rotocol-peer.js" 2>/dev/null || true', {
        timeoutMs: 30_000,
        master: lanSshMasters.bob ?? undefined,
      }),
      sshRun(lan.bob.ssh, `rm -rf ${shellQuote(`${lan.bob.workdir}/protocol-peer-bob`)}`, {
        timeoutMs: 30_000,
        master: lanSshMasters.bob ?? undefined,
      }),
    );
  }
  if (alice && !lanAliceOnHost) {
    jobs.push(
      sshRun(lan.alice.ssh, 'pkill -f "[p]rotocol-peer.js" 2>/dev/null || true', {
        timeoutMs: 30_000,
        master: lanSshMasters.alice ?? undefined,
      }),
      sshRun(lan.alice.ssh, `rm -rf ${shellQuote(`${lan.alice.workdir}/protocol-peer-alice`)}`, {
        timeoutMs: 30_000,
        master: lanSshMasters.alice ?? undefined,
      }),
    );
  }
  await Promise.all(jobs).catch(() => {});
  if (lanAliceOnHost) {
    const aliceBase = join(lan.alice.workdir, 'protocol-peer-alice-local');
    await rm(aliceBase, { recursive: true, force: true }).catch(() => {});
  }
}

async function startPair(category, hosts) {
  if (category === 'local') {
    const base = join(REPO_ROOT, '.local/bench/protocol/transfer-local');
    return ProtocolPair.startLocal(base, { readyTimeoutMs: 180000, friendMs: 120000 });
  }
  if (category === 'lan') {
    const lan = requireLan(hosts);
    if (!skipDeploy && !deployedCategories.has(category)) {
      await Promise.all([
        ensureRemoteWorkspace(lan.alice.ssh, lan.alice.workdir),
        ensureRemoteWorkspace(lan.bob.ssh, lan.bob.workdir),
      ]);
      deployedCategories.add(category);
    }
    await cleanupLanPeers(lan);
    await new Promise((r) => setTimeout(r, lanAliceOnHost ? 2000 : 3000));

    if (lanAliceOnHost) {
      log(`LAN peers: alice local on ${lan.alice.ssh}, bob remote ${lan.bob.ssh}, discovery=${LAN_DISCOVERY}`);
      return ProtocolPair.startHybrid(join(lan.alice.workdir, 'protocol-peer-alice-local'), lan.bob, {
        discovery: LAN_DISCOVERY,
        readyTimeoutMs: 240_000,
        friendMs: 120_000,
        sshExtra: () => lanSshMasters.bob?.sshOpts() ?? [],
      });
    }

    log(`LAN peers: alice remote ${lan.alice.ssh}, bob remote ${lan.bob.ssh}, discovery=${LAN_DISCOVERY}`);
    return ProtocolPair.startRemote(lan.alice, lan.bob, {
      discovery: LAN_DISCOVERY,
      readyTimeoutMs: 240_000,
      friendMs: 120_000,
      staggerMs: 2000,
      sshExtra: (host) => {
        if (host.ssh === lan.alice.ssh) return lanSshMasters.alice?.sshOpts() ?? [];
        if (host.ssh === lan.bob.ssh) return lanSshMasters.bob?.sshOpts() ?? [];
        return [];
      },
    });
  }
  const wan = requireWan(hosts);
  const bob = {
    ...wan.bob,
    label: process.env.NEARBYTES_PROTOCOL_WAN_BOB_LABEL ?? wan.bob.label,
    ssh: process.env.NEARBYTES_PROTOCOL_WAN_BOB_SSH ?? wan.bob.ssh,
    workdir: process.env.NEARBYTES_PROTOCOL_WAN_BOB_WORKDIR ?? wan.bob.workdir,
  };
  if (!skipDeploy && !deployedCategories.has(category)) {
    await ensureRemoteWorkspace(bob.ssh, bob.workdir);
    deployedCategories.add(category);
  }
  await rm(join(REPO_ROOT, '.local/bench/protocol/transfer-wan'), { recursive: true, force: true });
  await sshRun(
    bob.ssh,
    `pkill -f protocol-peer.js 2>/dev/null || true; rm -rf ${shellQuote(`${bob.workdir}/protocol-peer-bob`)}`,
    { timeoutMs: 30_000, master: wanSshMaster ?? undefined },
  ).catch(() => {});
  log(`WAN peers: alice local on Mac, bob remote ${bob.ssh}, discovery=${WAN_DISCOVERY}`);
  return ProtocolPair.startHybrid(join(REPO_ROOT, '.local/bench/protocol/transfer-wan'), bob, {
    discovery: WAN_DISCOVERY,
    readyTimeoutMs: 300000,
    friendMs: 180000,
    sshExtra: () => wanSshMaster?.sshOpts() ?? [],
  });
}

function isRetryableNearbytesError(err) {
  const msg = String(err?.message ?? err);
  return /peer-stalled|timeout|ECONNRESET|socket hang up/i.test(msg);
}

async function measureNearbytesSustainedOnPair(pair, plan, category) {
  const { minWallMs, warmupTransfers = 1 } = plan.sustained;
  const files = Array.from({ length: plan.count }, () => ({ bytes: plan.bytes }));
  const timeoutMs = nearbytesTimeoutMs(category, plan);
  const measured = await measureRepeated('nearbytes', plan, async (rep) => {
    log(
      `nearbytes ${plan.label} sustained rep ${rep + 1} — target ≥${minWallMs}ms wall ` +
        `(${plan.count}×${(plan.bytes / MIB).toFixed(1)} MiB per transfer)`,
    );
    const r = await pair.measureSustained({
      files,
      timeoutMs,
      burst: plan.burst,
      caseTag: `${plan.label}-r${rep}`,
      minWallMs,
      warmupTransfers: rep === 0 ? warmupTransfers : 0,
    });
    log(
      `nearbytes ${plan.label} sustained rep ${rep + 1} — ` +
        `e2e=${r.goodputMbps} Mb/s wire=${r.goodputWireMbps ?? 'n/a'} Mb/s ` +
        `wall=${r.wallMs}ms wireWin=${r.wireWindowMs}ms xfers=${r.transferCount}`,
    );
    return {
      wallMs: r.wallMs,
      bytes: r.bytes,
      goodputMbps: r.goodputMbps,
      goodputWireMbps: r.goodputWireMbps,
      wireWindowMs: r.wireWindowMs,
      transferCount: r.transferCount,
      sustainedTargetReached: r.sustainedTargetReached,
      wireTargetReached: r.wireTargetReached,
      runs: r.runs,
    };
  });
  const timelines = measured.runs.flatMap((r) => r.runs ?? []).map((t) => t.timeline).filter(Boolean);
  const timelineAgg = timelines.length ? aggregateTimelines(timelines) : null;
  const wireMbps = measured.runs.map((r) => r.goodputWireMbps).filter((n) => n != null);
  const goodputWireMbps =
    wireMbps.length > 0
      ? Number((wireMbps.reduce((a, b) => a + b, 0) / wireMbps.length).toFixed(2))
      : null;
  return {
    ...measured,
    mode: 'sustained',
    minWallMs,
    goodputWireMbps,
    friendSessionMs: pair.friendMs,
    timelineAgg,
  };
}

async function measureNearbytesOnPair(pair, plan, category, { restartPair } = {}) {
  if (plan.sustained) {
    return measureNearbytesSustainedOnPair(pair, plan, category);
  }
  let activePair = pair;
  // Fresh pair each rep on loopback/LAN keeps activity logs small; WAN skips (DHT attach is costly).
  const warmPair = process.env.NEARBYTES_TRANSFER_WARM_PAIR === '1';
  const freshPairEachRep = restartPair && (category === 'local' || category === 'lan') && !warmPair;
  const warmAttach = process.env.NEARBYTES_TRANSFER_WARM_ATTACH === '1';
  if (warmAttach && category === 'wan') {
    try {
      const files = Array.from({ length: plan.count }, () => ({ bytes: plan.bytes }));
      const timeoutMs = nearbytesTimeoutMs(category, plan);
      log(`nearbytes ${plan.label} warm-attach discard run`);
      await activePair.measureFiles({ files, timeoutMs, burst: plan.burst, caseTag: `${plan.label}-warm` });
    } catch (err) {
      log(`nearbytes ${plan.label} warm-attach discard failed (${err.message}) — continuing`);
    }
  }
  const measured = await measureRepeated('nearbytes', plan, async (rep) => {
    if (freshPairEachRep && rep > 0) {
      await activePair.stop().catch(() => {});
      killStrayProtocolPeers();
      await new Promise((r) => setTimeout(r, 800));
      activePair = await restartPair();
    }
    const maxAttempts = category === 'lan' ? 3 : 2;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const files = Array.from({ length: plan.count }, () => ({ bytes: plan.bytes }));
        const timeoutMs = nearbytesTimeoutMs(category, plan);
        log(`nearbytes ${plan.label} rep ${rep + 1} — publish ${plan.count}×${(plan.bytes / MIB).toFixed(1)} MiB (timeout=${timeoutMs}ms)`);
        const r = await activePair.measureFiles({ files, timeoutMs, burst: plan.burst, caseTag: plan.label });
        log(`nearbytes ${plan.label} rep ${rep + 1} — ${r.goodputMbps} Mb/s wall=${r.wallMs}ms publish=${r.publishWallMs}ms`);
        return {
          wallMs: r.wallMs,
          bytes: r.bytes,
          goodputMbps: r.goodputMbps,
          publishWallMs: r.publishWallMs,
          timeline: r.timeline,
          encode: r.encode,
          decode: r.decode,
        };
      } catch (err) {
        lastErr = err;
        if (!isRetryableNearbytesError(err) || attempt === maxAttempts) throw err;
        log(`nearbytes ${plan.label} rep ${rep + 1} attempt ${attempt} failed (${err.message}) — retrying`);
        if (restartPair) {
          activePair = await restartPair();
        } else {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    }
    throw lastErr ?? new Error(`nearbytes ${plan.label} rep ${rep + 1} failed`);
  });
  const resources = aggregateNearbytesResources(measured.runs);
  const timelines = measured.runs.map((r) => r.timeline).filter(Boolean);
  const timelineAgg = timelines.length ? aggregateTimelines(timelines) : null;
  return { ...measured, friendSessionMs: activePair.friendMs, resources, timelineAgg };
}

function selectedCases(category) {
  let pool = CASES;
  if (caseFilter.length > 0) {
    pool = CASES.filter((c) => caseFilter.includes(c.label));
    if (pool.length === 0) {
      throw new Error(`--cases matched nothing (wanted: ${caseFilter.join(', ')})`);
    }
    return pool;
  }
  if (category === 'local' && process.env.NEARBYTES_TRANSFER_MICRO !== '1' && !hasArg('--micro')) {
    return SUSTAINED_CASES;
  }
  if (category === 'local') {
    return MICRO_CASES;
  }
  return MICRO_CASES;
}

async function startFreshPair(category, hosts) {
  const maxAttempts = category === 'wan' ? 2 : 3;
  killStrayProtocolPeers();
  await new Promise((r) => setTimeout(r, 500));
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        log(`nearbytes — peer start attempt ${attempt}/${maxAttempts} after ${lastErr?.message ?? 'failure'}`);
        killStrayProtocolPeers();
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
      return await startPair(category, hosts);
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) throw err;
    }
  }
  throw lastErr ?? new Error('startFreshPair failed');
}

async function runCategory(category, hosts, report) {
  const plans = selectedCases(category);
  const baselines = BASELINE_SYSTEMS[category] ?? ['scp', 'rsync'];
  await ensureProtocolPeerBuilt();
  killStrayProtocolPeers();
  await new Promise((r) => setTimeout(r, 1000));

  /** @type {{ plan: typeof CASES[number], systems: Record<string, unknown> }[]} */
  const categoryResults = plans.map((plan) => ({ plan, systems: {} }));

  try {
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      log(`── ${category} / ${plan.label} (${plan.count}×${(plan.bytes / MIB).toFixed(1)} MiB) — nearbytes ──`);
      log(`nearbytes — fresh ${category} peer session for ${plan.label}`);
      let pair = await startFreshPair(category, hosts);
      const ownsPair = true;
      const restartPair = async () => {
        await pair.stop().catch(() => {});
        killStrayProtocolPeers();
        await new Promise((r) => setTimeout(r, 2000));
        pair = await startFreshPair(category, hosts);
        log(`nearbytes — restarted friend session alice=${pair.friendMs?.alice ?? '?'}ms bob=${pair.friendMs?.bob ?? '?'}ms`);
        return pair;
      };
      try {
        log(`nearbytes — friend session alice=${pair.friendMs?.alice ?? '?'}ms bob=${pair.friendMs?.bob ?? '?'}ms`);
        categoryResults[i].systems.nearbytes = await measureNearbytesOnPair(pair, plan, category, { restartPair });
        log(`── ${plan.label} nearbytes=${categoryResults[i].systems.nearbytes.goodputMbps} Mb/s ──`);
      } finally {
        if (ownsPair) {
          await pair.stop().catch(() => {});
          killStrayProtocolPeers();
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      report.results[category] = categoryResults;
      report.generatedAt = new Date().toISOString();
      report.status = 'in_progress';
      await writeCheckpoint(report);
    }

    if (!nearbytesOnly) {
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i];
        log(`── ${category} / ${plan.label} — baselines ──`);
        for (const b of baselines) {
          categoryResults[i].systems[b] = await baselineSystem(b, category, hosts, plan);
        }
        const parts = ['nearbytes', ...baselines].map((k) => `${k}=${categoryResults[i].systems[k].goodputMbps}`).join(' ');
        log(`── ${plan.label} done: ${parts} Mb/s ──`);
        report.results[category] = categoryResults;
        report.generatedAt = new Date().toISOString();
        report.status = 'in_progress';
        await writeCheckpoint(report);
      }
    }
  } finally {
    killStrayProtocolPeers();
  }
  return categoryResults;
}

async function localBaseline(system, plan) {
  if (plan.sustained) {
    const { minWallMs, warmupTransfers = 1 } = plan.sustained;
    const runSustained = system === 'nc' ? localNcSustained : localCatSustained;
    return measureRepeated(system, plan, async (rep) => {
      log(`${system} ${plan.label} sustained rep ${rep + 1} — target ≥${minWallMs}ms wall`);
      const { dir, files } = makeLocalFiles(plan, `${system}-${plan.label}-${rep}`);
      const recv = localScratch('baseline', `${system}-${plan.label}-${rep}-recv`);
      try {
        const t = await runSustained(files, recv, {
          minWallMs,
          warmupTransfers: rep === 0 ? warmupTransfers : 0,
        });
        const goodputMbps = mbps(t.bytes, t.wallMs);
        log(
          `${system} ${plan.label} sustained rep ${rep + 1} — ${goodputMbps} Mb/s ` +
            `wall=${t.wallMs}ms xfers=${t.count}`,
        );
        return {
          wallMs: t.wallMs,
          bytes: t.bytes,
          goodputMbps,
          goodputWireMbps: goodputMbps,
          transferCount: t.count,
          sustainedTargetReached: t.sustainedTargetReached,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(recv, { recursive: true, force: true });
      }
    }).then((m) => ({ ...m, mode: 'sustained', minWallMs, goodputWireMbps: m.goodputMbps }));
  }
  return measureRepeated(system, plan, async (rep) => {
    log(`${system} ${plan.label} rep ${rep + 1} — preparing ${plan.count} files`);
    const { dir, files } = makeLocalFiles(plan, `${system}-${plan.label}-${rep}`);
    const recv = localScratch('baseline', `${system}-${plan.label}-${rep}-recv`);
    try {
      const t = system === 'nc' ? await localNc(files, recv) : await localCat(files, recv);
      log(`${system} ${plan.label} rep ${rep + 1} — ${mbps(t.bytes, t.wallMs)} Mb/s wall=${t.wallMs}ms`);
      return { wallMs: t.wallMs, bytes: t.bytes, goodputMbps: mbps(t.bytes, t.wallMs) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(recv, { recursive: true, force: true });
    }
  });
}

async function wanRemoteTransfer(system, files, sshAlias, remoteDir, timeoutMs) {
  if (system === 'scp') {
    const extra = wanSshMaster ? wanSshMaster.sshOpts() : ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=15'];
    const t0 = Date.now();
    await runProc('scp', [
      '-q',
      '-O',
      ...extra,
      ...files.map((f) => f.path),
      `${sshAlias}:${remoteDir}/`,
    ], { timeoutMs });
    const wallMs = Date.now() - t0;
    const bytes = totalBytes(files);
    return { wallMs, bytes, goodputMbps: mbps(bytes, wallMs) };
  }
  const t = await remoteRsync(files, sshAlias, remoteDir, { master: wanSshMaster ?? undefined });
  return { wallMs: t.wallMs, bytes: t.bytes, goodputMbps: mbps(t.bytes, t.wallMs) };
}

async function remoteBaseline(system, category, hosts, plan) {
  if (category === 'lan') {
    const lan = requireLan(hosts);
    const pushOpts = { aliceLocal: lanAliceOnHost };
    return measureRepeated(system, plan, async (rep) => {
      const paths = [];
      for (let i = 0; i < plan.count; i++) {
        paths.push(await ensureAlicePayload(lan.alice, `${plan.label}-${system}-${rep}-${i}.bin`, plan.bytes, rep * 1000 + i + 1, pushOpts));
      }
      const wall = system === 'nc'
        ? await lanNc(lan.alice, lan.bob, paths, pushOpts)
        : system === 'scp'
          ? await lanScp(lan.alice, lan.bob, paths, pushOpts)
          : await lanRsync(lan.alice, lan.bob, paths, pushOpts);
      const bytes = plan.count * plan.bytes;
      return { wallMs: wall.wallMs, bytes, goodputMbps: mbps(bytes, wall.wallMs) };
    });
  }
  const wan = requireWan(hosts);
  const bob = {
    ...wan.bob,
    ssh: process.env.NEARBYTES_PROTOCOL_WAN_BOB_SSH ?? wan.bob.ssh,
    workdir: process.env.NEARBYTES_PROTOCOL_WAN_BOB_WORKDIR ?? wan.bob.workdir,
  };
  const remoteDir = `${bob.workdir}/transfer-baseline`;
  const timeoutMs = baselineTimeoutMs(plan);
  return measureRepeated(system, plan, async (rep) => {
    log(`${system} ${plan.label} rep ${rep + 1} — preparing ${plan.count} files`);
    const { dir, files } = makeLocalFiles(plan, `${system}-${plan.label}-${rep}`);
    try {
      await prepareRemoteDir(bob.ssh, remoteDir, { master: wanSshMaster ?? undefined });
      const t = await wanRemoteTransfer(system, files, bob.ssh, remoteDir, timeoutMs);
      log(`${system} ${plan.label} rep ${rep + 1} — ${t.goodputMbps} Mb/s wall=${t.wallMs}ms`);
      return { wallMs: t.wallMs, bytes: t.bytes, goodputMbps: t.goodputMbps };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

async function baselineSystem(system, category, hosts, plan) {
  return category === 'local'
    ? localBaseline(system, plan)
    : remoteBaseline(system, category, hosts, plan);
}

async function writeCheckpoint(report) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2));
}

async function main() {
  const hosts = await loadHosts();
  const startedAt = new Date().toISOString();
  killStrayProtocolPeers();

  const topology = {};
  for (const cat of categories) topology[cat] = topologyMeta(cat, hosts);

  log(`start categories=${categories.join(',')} targetMs=${targetMs} maxRepeats=${maxRepeats} out=${outPath}`);
  for (const cat of categories) {
    const t = topology[cat];
    log(`${cat}: peers=${t.peers} discovery=${t.discovery} alice=${t.alice} bob=${t.bob}`);
  }

  if (categories.includes('lan')) {
    const lan = requireLan(hosts);
    if (lanAliceOnHost) {
      log(`LAN ssh preflight bob=${lan.bob.ssh} (alice peer local on ${lan.alice.ssh})`);
      await sshPreflight(lan.bob.ssh);
      lanSshMasters.bob = new SshMaster(lan.bob.ssh);
      await lanSshMasters.bob.start();
      log(`LAN ssh ControlMaster ready for bob@${lan.bob.ssh}`);
    } else {
      log(`LAN ssh preflight alice=${lan.alice.ssh} bob=${lan.bob.ssh} (CNR↔CNR, mDNS)`);
      await Promise.all([sshPreflight(lan.alice.ssh), sshPreflight(lan.bob.ssh)]);
      lanSshMasters.alice = new SshMaster(lan.alice.ssh);
      lanSshMasters.bob = new SshMaster(lan.bob.ssh);
      await Promise.all([lanSshMasters.alice.start(), lanSshMasters.bob.start()]);
      log('LAN ssh ControlMaster ready for alice + bob');
    }
  }
  if (categories.includes('wan')) {
    const wan = requireWan(hosts);
    const bobSsh = process.env.NEARBYTES_PROTOCOL_WAN_BOB_SSH ?? wan.bob.ssh;
    log(`WAN ssh preflight bob=${bobSsh} (Mac↔CNR, DHT)`);
    wanSshMaster = new SshMaster(bobSsh);
    await wanSshMaster.start();
    await sshRun(bobSsh, 'echo ok', { timeoutMs: 60_000, master: wanSshMaster });
    log(`WAN ssh master ready for ${bobSsh}`);
  }

  const report = {
    generatedAt: startedAt,
    startedAt,
    targetMs,
    maxRepeats,
    categories,
    cases: CASES,
    topology,
    results: {},
    status: 'in_progress',
  };
  await writeCheckpoint(report);

  try {
    for (const category of categories) {
      report.results[category] = await runCategory(category, hosts, report);
    }
    report.generatedAt = new Date().toISOString();
    report.status = 'complete';
    await writeCheckpoint(report);
    process.stdout.write(`${outPath}\n`);
  } finally {
    if (wanSshMaster) await wanSshMaster.stop();
    await Promise.all([
      lanSshMasters.alice?.stop(),
      lanSshMasters.bob?.stop(),
    ].filter(Boolean));
  }
}

main().catch(async (err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  if (wanSshMaster) await wanSshMaster.stop().catch(() => {});
  await Promise.all([
    lanSshMasters.alice?.stop(),
    lanSshMasters.bob?.stop(),
  ].filter(Boolean));
  process.exit(1);
});
