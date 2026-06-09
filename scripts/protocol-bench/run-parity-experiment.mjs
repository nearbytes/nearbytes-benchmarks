#!/usr/bin/env node
/**
 * Parity experiment — compare harness tweaks toward nc/rsync on key rows.
 *
 *   yarn bench:parity
 *   yarn bench:parity -- --categories local
 *   yarn bench:parity -- --configs publish-pipeline,parity-all
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BENCH_TARGET_MS } from '../lib/local-config.mjs';
import { resolveBenchRepeatBudget } from '../lib/bench-timing.mjs';
import { envForOpts } from '../lib/optimization-flags.mjs';
import { killStrayProtocolPeers, ProtocolPair } from './lib/protocol-pair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MIB = 1024 * 1024;
const OUT = join(REPO, '.local/bench/protocol/parity-experiment.json');

const TARGET_CASES = {
  local: ['128MiB_x1_seq', '64MiB_4MiB_x16_burst'],
  wan: ['128MiB_x1_seq'],
};

const PLANS = {
  '128MiB_x1_seq': { label: '128MiB_x1_seq', count: 1, bytes: 128 * MIB, burst: false },
  '64MiB_4MiB_x16_burst': { label: '64MiB_4MiB_x16_burst', count: 16, bytes: 4 * MIB, burst: true },
};

const CONFIGS = [
  {
    id: 'baseline',
    label: 'Default stack',
    env: { NEARBYTES_OPT_BURST_PARALLEL: '1', NEARBYTES_OPT_PUBLISH_PIPELINE: '0' },
  },
  {
    id: 'publish-pipeline',
    label: 'Burst publish pipeline (width 4, no burst-parallel)',
    env: {
      NEARBYTES_OPT_PUBLISH_PIPELINE: '1',
      NEARBYTES_OPT_PUBLISH_PIPELINE_WIDTH: '4',
      NEARBYTES_OPT_BURST_PARALLEL: '0',
    },
  },
  {
    id: 'warm-pair',
    label: 'Warm loopback pair (no restart between reps)',
    env: { NEARBYTES_TRANSFER_WARM_PAIR: '1' },
  },
  {
    id: 'wan-warm-attach',
    label: 'WAN warm DHT attach (discard run before measure)',
    env: { NEARBYTES_TRANSFER_WARM_ATTACH: '1' },
    categories: ['wan'],
  },
  {
    id: 'parity-all',
    label: 'Combined parity tweaks',
    env: {
      NEARBYTES_OPT_PUBLISH_PIPELINE: '1',
      NEARBYTES_OPT_PUBLISH_PIPELINE_WIDTH: '4',
      NEARBYTES_OPT_BURST_PARALLEL: '0',
      NEARBYTES_TRANSFER_WARM_PAIR: '1',
      NEARBYTES_TRANSFER_WARM_ATTACH: '1',
    },
  },
];

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const categories = arg('--categories', 'local,wan').split(',').map((s) => s.trim()).filter(Boolean);
const configFilter = arg('--configs', '').split(',').map((s) => s.trim()).filter(Boolean);
const { targetMs, maxRepeats } = resolveBenchRepeatBudget({
  targetMs: arg('--target-ms', String(DEFAULT_BENCH_TARGET_MS)),
  maxRepeats: arg('--max-repeats', '3'),
  label: 'parity',
});

function mbps(bytes, ms) {
  return ms > 0 ? (bytes * 8) / (ms * 1000) : 0;
}

function log(msg) {
  process.stderr.write(`[parity] ${msg}\n`);
}

async function measureConfig(category, plan, config) {
  const base = join(REPO, '.local/bench/protocol/parity', `${config.id}-${category}`);
  const env = envForOpts(new Set(), { ...process.env, ...config.env });
  const prev = { ...process.env };
  Object.assign(process.env, env);
  killStrayProtocolPeers();
  let pair;
  const runs = [];
  let totalMs = 0;
  let totalBytes = 0;
  try {
    if (category === 'wan') {
      const { loadHosts, requireWan } = await import('../network-bench/lib/hosts.mjs');
      const hosts = await loadHosts();
      const wan = requireWan(hosts);
      pair = await ProtocolPair.startHybrid(
        join(base, 'alice'),
        { ssh: process.env.NEARBYTES_PROTOCOL_WAN_BOB_SSH ?? wan.bob.ssh, workdir: wan.bob.workdir },
        { discovery: 'dht', friendMs: 120000, readyTimeoutMs: 300000 },
      );
    } else {
      pair = await ProtocolPair.startLocal(base, { readyTimeoutMs: 180000, friendMs: 120000 });
    }

    const warmAttach = process.env.NEARBYTES_TRANSFER_WARM_ATTACH === '1' && category === 'wan';
    if (warmAttach) {
      const files = Array.from({ length: plan.count }, () => ({ bytes: plan.bytes }));
      log(`${config.id} ${plan.label} warm-attach discard`);
      await pair.measureFiles({
        files,
        timeoutMs: category === 'wan' ? 600_000 : 120_000,
        burst: plan.burst,
        caseTag: `${plan.label}-warm`,
      });
    }

    const warmPair =
      process.env.NEARBYTES_TRANSFER_WARM_PAIR === '1' && (category === 'local' || category === 'lan');
    const restartBetweenReps = !warmPair && category !== 'wan';
    while (runs.length < maxRepeats && totalMs < targetMs) {
      if (restartBetweenReps && runs.length > 0) {
        await pair.stop().catch(() => {});
        killStrayProtocolPeers();
        await new Promise((r) => setTimeout(r, 500));
        pair = await ProtocolPair.startLocal(join(base, `r${runs.length}`), {
          readyTimeoutMs: 180000,
          friendMs: 120000,
        });
      }
      const files = Array.from({ length: plan.count }, () => ({ bytes: plan.bytes }));
      const r = await pair.measureFiles({
        files,
        timeoutMs: category === 'wan' ? 600_000 : 120_000,
        burst: plan.burst,
        caseTag: `${plan.label}-r${runs.length}`,
      });
      runs.push(r);
      totalMs += r.wallMs;
      totalBytes += r.bytes;
      log(
        `${config.id} ${category} ${plan.label} rep ${runs.length}: ${r.goodputMbps} Mb/s ` +
          `wall=${r.wallMs}ms publish=${r.publishWallMs}ms`,
      );
    }
  } finally {
    await pair?.stop().catch(() => {});
    Object.assign(process.env, prev);
  }
  return {
    configId: config.id,
    category,
    plan: plan.label,
    repeats: runs.length,
    goodputMbps: mbps(totalBytes, totalMs),
    wallMs: totalMs,
    runs,
  };
}

async function main() {
  const { spawnSync } = await import('node:child_process');
  log('build');
  const b = spawnSync('yarn', ['build'], { cwd: REPO, stdio: 'inherit', shell: true });
  if (b.status !== 0) process.exit(b.status ?? 1);

  const configs = CONFIGS.filter((c) => configFilter.length === 0 || configFilter.includes(c.id));
  const results = [];
  for (const category of categories) {
    for (const caseLabel of TARGET_CASES[category] ?? []) {
      const plan = PLANS[caseLabel];
      if (!plan) continue;
      for (const config of configs) {
        if (config.categories && !config.categories.includes(category)) continue;
        results.push(await measureConfig(category, plan, config));
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    targetMs,
    maxRepeats,
    results,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(report, null, 2));
  console.log(`\n=== Parity experiment ===\n`);
  for (const category of categories) {
    for (const caseLabel of TARGET_CASES[category] ?? []) {
      const rows = results.filter((r) => r.category === category && r.plan === caseLabel);
      if (!rows.length) continue;
      const base = rows.find((r) => r.configId === 'baseline');
      console.log(`${category} / ${caseLabel}:`);
      for (const row of rows) {
        const delta = base && row.configId !== 'baseline'
          ? ((row.goodputMbps / base.goodputMbps - 1) * 100).toFixed(1)
          : '---';
        console.log(
          `  ${row.configId.padEnd(18)} ${row.goodputMbps.toFixed(1).padStart(8)} Mb/s  (${row.repeats} reps, Δ vs baseline ${delta}%)`,
        );
      }
      console.log('');
    }
  }
  console.log(`wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
