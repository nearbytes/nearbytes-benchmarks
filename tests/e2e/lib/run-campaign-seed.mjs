#!/usr/bin/env node
/** Run one campaign-profile Alice+Bob seed (used by bench:campaign / e2e:campaign:multi). */

import { mkdir, rm } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { getRepoRoot } from './config.mjs';
import { spawnBench, sleep, killStaleBenchProcesses, stopBenchChild } from './spawn-bench.mjs';

const repoRoot = getRepoRoot();
const seedDir = process.env['NEARBYTES_CAMPAIGN_SEED_DIR'];
const workBase = process.env['NEARBYTES_CAMPAIGN_WORK_BASE'] ?? path.join(seedDir, 'work');

if (!seedDir) {
  console.error('NEARBYTES_CAMPAIGN_SEED_DIR required');
  process.exit(1);
}

function runNode(args) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`exit ${c}`))));
  });
}

killStaleBenchProcesses();
await rm(workBase, { recursive: true, force: true });
await mkdir(workBase, { recursive: true });

const common = {
  NEARBYTES_BENCH_BASE: workBase,
  NEARBYTES_BENCH_PROFILE: 'campaign',
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

const bob = spawnBench('bob', {
  ...common,
  NEARBYTES_BENCH_ROLE: 'receiver',
  NEARBYTES_BENCH_OUT: path.join(workBase, 'bob/benchmark-result.json'),
});
await sleep(Number(process.env['NEARBYTES_BENCH_BOB_LEAD_MS'] ?? 500));
const alice = spawnBench('alice', {
  ...common,
  NEARBYTES_BENCH_ROLE: 'sender',
  NEARBYTES_BENCH_OUT: path.join(workBase, 'alice/benchmark-result.json'),
});

try {
  await Promise.all([bob.wait(), alice.wait()]);
} catch (err) {
  stopBenchChild(bob.child);
  stopBenchChild(alice.child);
  killStaleBenchProcesses();
  throw err;
}

await runNode([
  path.join(repoRoot, 'scripts/merge-benchmark-results.mjs'),
  '--sender',
  path.join(workBase, 'alice/benchmark-result.json'),
  '--manifest',
  path.join(workBase, 'alice/trial-manifest.json'),
  '--receiver',
  path.join(workBase, 'bob/benchmark-result.json'),
  '--out',
  path.join(seedDir, 'bench-report.json'),
  '--topology',
  'localhost campaign profile',
  '--quiet',
]);
