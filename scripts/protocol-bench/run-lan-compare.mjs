#!/usr/bin/env node
/**
 * Minimal LAN compare — one payload, three systems, ≤60s each.
 *
 * Runs ON pc-ciancia (--lan-alice-on-host): CNR alice ↔ CNR bob, mDNS.
 * Measures nearbytes, scp, rsync for the same 64 MiB file.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureRemoteWorkspace } from '../network-bench/lib/deploy.mjs';
import { ensureAlicePayload, lanRsync, lanScp } from '../network-bench/lib/baselines.mjs';
import { loadHosts, requireLan } from '../network-bench/lib/hosts.mjs';
import { shellQuote, sshRun, SshMaster } from '../network-bench/lib/remote.mjs';
import { ProtocolPair, ensureProtocolPeerBuilt, killStrayProtocolPeers } from './lib/protocol-pair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const MIB = 1024 * 1024;
const LAN_DISCOVERY = 'mdns';

const CASE = {
  label: '64MiB_x1',
  count: 1,
  bytes: 64 * MIB,
  burst: false,
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const hasArg = (name) => process.argv.includes(name);
const limitMs = Number(arg('--limit-ms', process.env.NEARBYTES_LAN_COMPARE_LIMIT_MS ?? '30000'));
const outPath = arg('--out', join(REPO_ROOT, '.local/bench/protocol/lan-compare.json'));
const skipDeploy = hasArg('--skip-deploy');
const baselinesOnly = hasArg('--baselines-only');

const lanAliceOnHost = hasArg('--lan-alice-on-host')
  || process.env.NEARBYTES_LAN_ALICE_ON_HOST === '1';

function log(msg) {
  process.stderr.write(`[lan-compare ${new Date().toISOString()}] ${msg}\n`);
}

function mbps(bytes, ms) {
  return ms > 0 ? Number(((bytes * 8) / ms / 1000).toFixed(2)) : 0;
}

async function main() {
  if (!lanAliceOnHost) {
    throw new Error('run on pc-ciancia with --lan-alice-on-host (or NEARBYTES_LAN_ALICE_ON_HOST=1)');
  }

  const hosts = await loadHosts();
  const lan = requireLan(hosts);
  const startedAt = new Date().toISOString();

  log(`LAN compare: ${CASE.label} limit=${limitMs}ms alice=${lan.alice.ssh} bob=${lan.bob.ssh} discovery=${LAN_DISCOVERY}`);

  if (!skipDeploy) {
    log('deploy alice + bob…');
    await Promise.all([
      ensureRemoteWorkspace(lan.alice.ssh, lan.alice.workdir),
      ensureRemoteWorkspace(lan.bob.ssh, lan.bob.workdir),
    ]);
  }

  await ensureProtocolPeerBuilt();
  killStrayProtocolPeers();

  const bobMaster = new SshMaster(lan.bob.ssh);
  await bobMaster.start();

  const report = {
    startedAt,
    limitMs,
    case: CASE,
    topology: {
      peers: 'cnr-cnr',
      discovery: LAN_DISCOVERY,
      orchestrator: lan.alice.ssh,
      alice: lan.alice.ssh,
      bob: lan.bob.ssh,
    },
    results: {},
    status: 'in_progress',
  };

  try {
    if (!baselinesOnly) {
      log('── nearbytes ──');
      await sshRun(lan.bob.ssh, 'pkill -f "[p]rotocol-peer.js" 2>/dev/null || true', { master: bobMaster }).catch(() => {});
      await sshRun(lan.bob.ssh, `rm -rf ${shellQuote(`${lan.bob.workdir}/protocol-peer-bob`)}`, { master: bobMaster }).catch(() => {});

      const pair = await ProtocolPair.startHybrid(
        join(lan.alice.workdir, 'protocol-peer-alice-local'),
        lan.bob,
        {
          discovery: LAN_DISCOVERY,
          readyTimeoutMs: limitMs,
          friendMs: Math.min(limitMs, 90_000),
          sshExtra: () => bobMaster.sshOpts(),
        },
      );
      try {
        const r = await pair.measureFiles({
          files: [{ bytes: CASE.bytes }],
          timeoutMs: limitMs,
          burst: false,
          caseTag: CASE.label,
        });
        report.results.nearbytes = {
          wallMs: r.wallMs,
          bytes: r.bytes,
          goodputMbps: r.goodputMbps,
          publishWallMs: r.publishWallMs,
          friendSessionMs: pair.friendMs,
          ok: r.wallMs <= limitMs,
        };
        log(`nearbytes ${r.goodputMbps} Mb/s wall=${r.wallMs}ms`);
      } finally {
        await pair.stop().catch(() => {});
        killStrayProtocolPeers();
      }
    }

    const pushOpts = { aliceLocal: true };
    const payloadPath = await ensureAlicePayload(
      lan.alice,
      `${CASE.label}-baseline.bin`,
      CASE.bytes,
      42,
      pushOpts,
    );

    for (const tool of ['scp', 'rsync']) {
      log(`── ${tool} ──`);
      const t0 = Date.now();
      const wall = tool === 'scp'
        ? await lanScp(lan.alice, lan.bob, [payloadPath], pushOpts)
        : await lanRsync(lan.alice, lan.bob, [payloadPath], pushOpts);
      const elapsed = Date.now() - t0;
      if (wall.wallMs > limitMs) {
        throw new Error(`${tool} exceeded ${limitMs}ms wall=${wall.wallMs}`);
      }
      report.results[tool] = {
        wallMs: wall.wallMs,
        bytes: CASE.bytes,
        goodputMbps: mbps(CASE.bytes, wall.wallMs),
        ok: wall.wallMs <= limitMs,
        harnessMs: elapsed,
      };
      log(`${tool} ${report.results[tool].goodputMbps} Mb/s wall=${wall.wallMs}ms`);
    }

    report.generatedAt = new Date().toISOString();
    report.status = 'complete';
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    process.stdout.write(`${outPath}\n`);
  } finally {
    await bobMaster.stop();
    killStrayProtocolPeers();
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
