#!/usr/bin/env node
/**
 * Protocol benchmark — WAN (local Alice ↔ remote Bob).
 *
 * Defaults come from config/local.json, with environment
 * overrides for one-off private targets:
 *
 *   NEARBYTES_PROTOCOL_WAN_BOB_SSH=fmt-5000 \
 *   NEARBYTES_PROTOCOL_WAN_BOB_WORKDIR=/home/vincenzo/nearbytes-bench \
 *   yarn bench:protocol:wan
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { collectLocalHostInfo, collectRemoteHostInfo } from '../network-bench/lib/hostinfo.mjs';
import { loadHosts, requireWan } from '../network-bench/lib/hosts.mjs';
import { ensureRemoteWorkspace } from '../network-bench/lib/deploy.mjs';
import { ProtocolPair, ensureProtocolPeerBuilt } from './lib/protocol-pair.mjs';
import { runProtocolSuite } from './lib/run-suite.mjs';
import { runDir } from './lib/record.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SKIP_DEPLOY = process.argv.includes('--skip-deploy');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function remoteFromEnv(base) {
  return {
    ...base,
    label: process.env.NEARBYTES_PROTOCOL_WAN_BOB_LABEL ?? base.label ?? process.env.NEARBYTES_PROTOCOL_WAN_BOB_SSH,
    ssh: process.env.NEARBYTES_PROTOCOL_WAN_BOB_SSH ?? base.ssh,
    workdir: process.env.NEARBYTES_PROTOCOL_WAN_BOB_WORKDIR ?? base.workdir,
  };
}

const outDir = arg('--outdir', runDir(REPO_ROOT, 'wan'));
const summaryLink = arg('--summary', join(REPO_ROOT, '.local/bench/protocol/wan-results.json'));

async function main() {
  if (!process.env.NEARBYTES_PROTOCOL_MATRIX) {
    process.env.NEARBYTES_PROTOCOL_MATRIX = 'wan,chat-sync,chat-replay,file';
  }

  const hosts = await loadHosts();
  const wan = requireWan(hosts);
  const bob = remoteFromEnv(wan.bob);
  if (!bob?.ssh || !bob?.workdir) {
    throw new Error('WAN protocol benchmark requires bob.ssh and bob.workdir');
  }

  if (!SKIP_DEPLOY) {
    process.stdout.write(`deploying WAN host ${bob.label ?? bob.ssh}...\n`);
    await ensureRemoteWorkspace(bob.ssh, bob.workdir);
  }

  await ensureProtocolPeerBuilt();

  const [hostLocal, hostBob] = await Promise.all([
    collectLocalHostInfo(),
    collectRemoteHostInfo(bob.ssh),
  ]);

  await runProtocolSuite({
    category: 'wan',
    repoRoot: REPO_ROOT,
    outDir,
    summaryLink,
    machines: { local: hostLocal, bob: hostBob },
    extraMeta: {
      aliceHost: { label: hosts.local?.label ?? 'local', ssh: null },
      bobHost: { label: bob.label, ssh: bob.ssh },
    },
    startPair: () =>
      ProtocolPair.startHybrid(join(REPO_ROOT, '.local/bench/protocol/wan-local'), bob, {
        discovery: process.env.NEARBYTES_PROTOCOL_WAN_DISCOVERY ?? 'dht',
        readyTimeoutMs: envInt('NEARBYTES_PROTOCOL_WAN_READY_MS', 240_000),
        friendMs: envInt('NEARBYTES_PROTOCOL_WAN_FRIEND_MS', 120_000),
      }),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
