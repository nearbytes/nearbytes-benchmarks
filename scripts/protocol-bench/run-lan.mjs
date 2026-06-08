#!/usr/bin/env node
/**
 * Protocol benchmark — LAN (pc-ciancia ↔ zombie).
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { collectLocalHostInfo, collectRemoteHostInfo } from '../network-bench/lib/hostinfo.mjs';
import { loadHosts, requireLan } from '../network-bench/lib/hosts.mjs';
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

const outDir = arg('--outdir', runDir(REPO_ROOT, 'lan'));
const summaryLink = arg('--summary', join(REPO_ROOT, '.local/bench/protocol/lan-results.json'));

async function main() {
  const hosts = await loadHosts();
  const lan = requireLan(hosts);

  if (!SKIP_DEPLOY) {
    process.stdout.write('deploying LAN hosts…\n');
    await Promise.all([
      ensureRemoteWorkspace(lan.alice.ssh, lan.alice.workdir),
      ensureRemoteWorkspace(lan.bob.ssh, lan.bob.workdir),
    ]);
  }

  await ensureProtocolPeerBuilt();

  const [hostLocal, hostAlice, hostBob] = await Promise.all([
    collectLocalHostInfo(),
    collectRemoteHostInfo(lan.alice.ssh),
    collectRemoteHostInfo(lan.bob.ssh),
  ]);

  await runProtocolSuite({
    category: 'lan',
    repoRoot: REPO_ROOT,
    outDir,
    summaryLink,
    machines: { local: hostLocal, alice: hostAlice, bob: hostBob },
    extraMeta: {
      aliceHost: { label: lan.alice.label, ssh: lan.alice.ssh, ip: lan.alice.ip },
      bobHost: { label: lan.bob.label, ssh: lan.bob.ssh, ip: lan.bob.ip },
    },
    startPair: () =>
      ProtocolPair.startRemote(lan.alice, lan.bob, {
        discovery: 'mdns',
        readyTimeoutMs: 240_000,
        friendMs: 120_000,
      }),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
