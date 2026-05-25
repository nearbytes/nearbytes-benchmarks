#!/usr/bin/env node
/**
 * Multi-seed paper campaign: K independent paper-profile runs → aggregate JSON + terminal.
 * LaTeX: yarn paper:figures (after this completes).
 *
 *   yarn e2e:paper:campaign
 *   NEARBYTES_BENCH_CAMPAIGN_SEEDS=3 yarn e2e:paper:campaign
 */

import { mkdir, rm, access, copyFile, symlink } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { getBenchPaths, getRepoRoot } from './lib/config.mjs';
import { spawnBench, sleep, killStaleBenchProcesses } from './lib/spawn-bench.mjs';
import { readBenchReport } from '../../scripts/bench-json.mjs';
import { printBenchReport } from '../../scripts/bench-report-print.mjs';
import { ensureBenchmarkBuilt } from '../../scripts/ensure-built.mjs';

const INTER_SEED_MS = Number(process.env['NEARBYTES_BENCH_INTER_SEED_MS'] ?? 3000);
const BOB_LEAD_MS = Number(process.env['NEARBYTES_BENCH_BOB_LEAD_MS'] ?? 500);
const seedCount = Math.max(
  1,
  Number(process.env['NEARBYTES_BENCH_CAMPAIGN_SEEDS'] ?? 5) || 5,
);

const repoRoot = getRepoRoot();
const paths = await getBenchPaths();
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const campaignDir = path.join(paths.benchReportsDir, 'e2e-paper-campaign', runId);
const latestDir = path.join(paths.benchReportsDir, 'e2e-paper-campaign', 'latest');

function runNode(args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      ...opts,
    });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${args[0]} exit ${c}`))));
  });
}


async function runSeed(seed) {
  const seedDir = path.join(campaignDir, `seed-${seed}`);
  const workBase = path.join(seedDir, 'work');
  await rm(seedDir, { recursive: true, force: true });
  await mkdir(workBase, { recursive: true });

  const common = {
    NEARBYTES_BENCH_BASE: workBase,
    NEARBYTES_BENCH_PROFILE: 'paper',
    NEARBYTES_BENCH_SKIP_FIGURES: '1',
    NEARBYTES_BENCH_DISCOVERY_MS: '2000',
    NEARBYTES_BENCH_GRACE_MS: '3000',
    NEARBYTES_BENCH_LATENCY_TIMEOUT_MS: '0',
    NEARBYTES_BENCH_THROUGHPUT_TIMEOUT_MS: '0',
    NEARBYTES_BENCH_TRIAL_ACK_MS: '0',
    NEARBYTES_BENCH_SYNC_READY_MS: '0',
    NEARBYTES_BENCH_SWARM_TIMEOUT_MS: '0',
    NEARBYTES_BENCH_MERGE_QUIET: '1',
  };

  if (seed > 1 && INTER_SEED_MS > 0) {
    console.log(`Inter-seed cooldown ${INTER_SEED_MS}ms…`);
    await sleep(INTER_SEED_MS);
  }

  console.log(`\n═══ seed ${seed}/${seedCount} (workdir ${workBase}) ═══\n`);

  const bob = spawnBench('bob', {
    ...common,
    NEARBYTES_BENCH_ROLE: 'receiver',
    NEARBYTES_BENCH_OUT: path.join(workBase, 'bob/benchmark-result.json'),
  });
  await sleep(BOB_LEAD_MS);
  const alice = spawnBench('alice', {
    ...common,
    NEARBYTES_BENCH_ROLE: 'sender',
    NEARBYTES_BENCH_OUT: path.join(workBase, 'alice/benchmark-result.json'),
  });

  await Promise.all([bob.wait(), alice.wait()]);

  const reportPath = path.join(seedDir, 'bench-report.json');
  await runNode([
    path.join(repoRoot, 'scripts/merge-benchmark-results.mjs'),
    '--sender',
    path.join(workBase, 'alice/benchmark-result.json'),
    '--manifest',
    path.join(workBase, 'alice/trial-manifest.json'),
    '--receiver',
    path.join(workBase, 'bob/benchmark-result.json'),
    '--out',
    reportPath,
    '--topology',
    `localhost paper campaign seed ${seed}`,
    '--quiet',
  ]);
  return reportPath;
}

await ensureBenchmarkBuilt();
killStaleBenchProcesses();
await mkdir(campaignDir, { recursive: true });

const t0 = Date.now();
for (let s = 1; s <= seedCount; s++) {
  await runSeed(s);
}
console.log(`\nAll seeds done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const campaignReport = path.join(campaignDir, 'bench-campaign-report.json');
await runNode([
  path.join(repoRoot, 'scripts/aggregate-campaign.mjs'),
  '--indir',
  campaignDir,
  '--out',
  campaignReport,
  '--topology',
  `localhost paper campaign (${seedCount} seeds)`,
]);

await rm(latestDir, { recursive: true, force: true });
await mkdir(latestDir, { recursive: true });
await copyFile(campaignReport, path.join(latestDir, 'bench-campaign-report.json'));
try {
  await symlink(campaignDir, path.join(latestDir, 'run'), 'dir');
} catch (err) {
  console.warn('[e2e:paper:campaign] latest symlink:', err.message);
}

const report = await readBenchReport(campaignReport);
printBenchReport(report, {
  title: `e2e:paper:campaign complete (${seedCount} seeds)`,
  reportPath: campaignReport,
});
console.log(`  latest:  ${path.join(latestDir, 'bench-campaign-report.json')}`);
console.log(`  figures: yarn paper:figures\n`);
