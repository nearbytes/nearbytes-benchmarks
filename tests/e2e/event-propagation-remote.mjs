#!/usr/bin/env node
/**
 * WAN propagation: Mac holder → pc-ciancia joiner (~5s target, 20s wall).
 *   yarn e2e:propagation:remote
 *   NBF_PROP_SKIP_RSYNC=1  — skip dist push when already deployed
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { getBenchPaths, getRemoteHost, getRemoteFilesRoot, getRepoRoot } from './lib/config.mjs';

const FILES_ROOT = join(getRepoRoot(), '..', 'nearbytes-files');
const PROBE = join(FILES_ROOT, 'scripts/event-propagation-probe.mjs');
/** Loopback uses 3s/2s; WAN peer discovery often needs longer (override via env). */
const PEER_MS = Number(process.env.NBF_PROP_PEER_TIMEOUT_MS ?? 12_000);
const MEASURE_MS = Number(process.env.NBF_PROP_MEASURE_TIMEOUT_MS ?? 8_000);
const WALL_MS = Number(process.env.NBF_PROP_WALL_MS ?? 30_000);
const DISCOVERY = process.env.NBF_PROP_DISCOVERY ?? 'all';

const paths = await getBenchPaths();
const remoteHost = await getRemoteHost();
const remoteFilesRoot = (await getRemoteFilesRoot()).replace(/^~/, '/home/vincenzo');
const sshOpts = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${paths.sshConnectTimeoutSec}`];

if (!process.env.NBF_PROP_SKIP_BUILD && !existsSync(join(FILES_ROOT, 'dist/cli/context.js'))) {
  execSync('yarn build', { cwd: FILES_ROOT, stdio: 'inherit' });
}

if (process.env.NBF_PROP_SKIP_RSYNC !== '1') {
  execSync(`rsync -az -e ssh ${join(FILES_ROOT, 'dist/')} ${remoteHost}:${remoteFilesRoot}/dist/`, {
    stdio: 'inherit',
  });
  execSync(`rsync -az -e ssh ${PROBE} ${remoteHost}:${remoteFilesRoot}/scripts/event-propagation-probe.mjs`, {
    stdio: 'inherit',
  });
}

function spawnLocal(role, base, target) {
  return spawnNode(role, base, target, FILES_ROOT);
}

function spawnRemote(role, remoteBase, target) {
  const cmd = [
    `mkdir -p '${remoteBase}'`,
    `cd '${remoteFilesRoot}'`,
    [
      'exec env',
      `NEARBYTES_SYNC_DISCOVERY=${DISCOVERY}`,
      `NBF_PROP_ROLE=${role}`,
      `NBF_PROP_BASE='${remoteBase}'`,
      `NBF_PROP_TARGET='${target}'`,
      'NBF_PROP_NO_THROW=1',
      `NBF_PROP_PEER_TIMEOUT_MS=${PEER_MS}`,
      `NBF_PROP_MEASURE_TIMEOUT_MS=${MEASURE_MS}`,
      `node '${remoteFilesRoot}/scripts/event-propagation-probe.mjs'`,
    ].join(' '),
  ].join(' && ');
  const child = spawn('ssh', [...sshOpts, remoteHost, cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
  return attach(child, true);
}

function spawnNode(role, base, target, cwd) {
  const child = spawn(process.execPath, [PROBE], {
    cwd,
    env: {
      ...process.env,
      NEARBYTES_SYNC_DISCOVERY: DISCOVERY,
      NBF_PROP_ROLE: role,
      NBF_PROP_BASE: base,
      NBF_PROP_TARGET: target,
      NBF_PROP_NO_THROW: '1',
      NBF_PROP_PEER_TIMEOUT_MS: String(PEER_MS),
      NBF_PROP_MEASURE_TIMEOUT_MS: String(MEASURE_MS),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return attach(child, false);
}

function attach(child, remote) {
  const lines = [];
  createInterface({ input: child.stdout }).on('line', (l) => {
    const t = l.trim();
    if (t) lines.push(t);
  });
  child.stderr.on('data', (d) => process.stderr.write(remote ? `[remote] ${d}` : d));
  return {
    child,
    lines,
    send: (o) => child.stdin.write(`${JSON.stringify(o)}\n`),
  };
}

async function waitPhase(lines, phase, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.phase === phase) {
          return { msg, seenAt: Date.now() };
        }
      } catch {
        /* skip */
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout phase=${phase}`);
}

function findResult(lines) {
  for (const line of lines) {
    try {
      const p = JSON.parse(line).phase;
      if (p === 'measured' || p === 'timeout') return JSON.parse(line);
    } catch {
      /* skip */
    }
  }
  return null;
}

function pickPeerTiming(msg) {
  if (!msg || msg.phase !== 'ready') return null;
  return {
    bootMs: msg.bootMs ?? null,
    peerWaitMs: msg.peerWaitMs ?? null,
    peerConnectMs: msg.peerConnectMs ?? null,
  };
}

async function waitJoinerResult(lines, timeoutMs) {
  const deadline = Date.now() + timeoutMs + 600;
  while (Date.now() < deadline) {
    const hit = findResult(lines);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

const target = `prop-wan-${Date.now()}.txt`;
const stamp = String(Date.now());
const localBase = join(getRepoRoot(), '.local', 'e2e', 'propagation', stamp);
const remoteBase = `${paths.benchBaseRemote}/e2e/propagation/${stamp}`;
await mkdir(localBase, { recursive: true });

console.error(`propagation remote holder=local joiner=${remoteHost} (peer≤${PEER_MS}ms measure≤${MEASURE_MS}ms wall≤${WALL_MS}ms)\n`);

const JOINER_HEAD_START_MS = Number(process.env.NBF_PROP_JOINER_HEAD_START_MS ?? 0);

const t0 = Date.now();
const joiner = spawnRemote('joiner', remoteBase, target);
const joinerSpawnAt = Date.now();
if (JOINER_HEAD_START_MS > 0) {
  await new Promise((r) => setTimeout(r, JOINER_HEAD_START_MS));
}
const holder = spawnLocal('holder', localBase, target);
const holderSpawnAt = Date.now();
const stop = () => {
  holder.child.kill('SIGTERM');
  joiner.child.kill('SIGTERM');
};
const wall = setTimeout(stop, WALL_MS);

try {
  const [holderReady, joinerReady] = await Promise.all([
    waitPhase(holder.lines, 'ready', PEER_MS),
    waitPhase(joiner.lines, 'ready', PEER_MS),
  ]);
  const goSentAt = Date.now();
  const go = { cmd: 'go', t0: goSentAt };
  holder.send(go);
  joiner.send(go);
  const published = await waitPhase(holder.lines, 'published', MEASURE_MS);
  let measured = await waitJoinerResult(joiner.lines, MEASURE_MS);
  if (!measured) {
    measured = {
      phase: 'timeout',
      blockMs: null,
      eventMs: null,
      listMs: null,
      eventBeforeListMs: null,
      blockBeforeEventMs: null,
      files: [],
    };
  }

  const doneAt = Date.now();
  const report = {
    ok: measured.phase === 'measured',
    wallMs: doneAt - t0,
    remoteHost,
    target,
    harness: {
      joinerHeadStartMs: JOINER_HEAD_START_MS,
      joinerSpawnToHolderSpawnMs: holderSpawnAt - joinerSpawnAt,
      joinerReadySeenMs: joinerReady.seenAt - joinerSpawnAt,
      holderReadySeenMs: holderReady.seenAt - holderSpawnAt,
      bothReadyMs: Math.max(joinerReady.seenAt, holderReady.seenAt) - t0,
      goSentMs: goSentAt - t0,
      doneMs: doneAt - t0,
    },
    peerTiming: {
      holder: pickPeerTiming(holderReady.msg),
      joiner: pickPeerTiming(joinerReady.msg),
    },
    publishMs: published.msg.publishMs,
    blockMs: measured.blockMs,
    eventMs: measured.eventMs,
    listMs: measured.listMs,
    eventBeforeListMs: measured.eventBeforeListMs,
    blockBeforeEventMs: measured.blockBeforeEventMs,
    afterGoMs: {
      publish: published.msg.publishMs,
      event: measured.eventMs,
      list: measured.listMs,
    },
    timedOut: measured.phase === 'timeout',
    files: measured.files,
  };

  const outPath = join(paths.e2eWorkDir, 'propagation-remote-latest.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
} finally {
  clearTimeout(wall);
  stop();
}
