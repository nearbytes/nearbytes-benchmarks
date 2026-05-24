#!/usr/bin/env node
/**
 * Single-seed paper profile: warmup, latency sweep, stream goodput → JSON + terminal.
 * LaTeX: yarn paper:figures --report <path>
 *
 *   yarn e2e:paper:local
 */

import { mkdir, rm, access } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { getBenchPaths, getRepoRoot } from './lib/config.mjs';
import { spawnBench, sleep } from './lib/spawn-bench.mjs';
import { readBenchReport } from '../../scripts/bench-json.mjs';
import { printBenchReport } from '../../scripts/bench-report-print.mjs';
import { ensureBenchmarkBuilt } from '../../scripts/ensure-built.mjs';

const repoRoot = getRepoRoot();
const paths = await getBenchPaths();
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runBase = path.join(paths.e2eWorkDir, runId, 'paper');
const reportDir = path.join(paths.benchReportsDir, 'e2e-paper-local');
const reportPath = path.join(reportDir, 'bench-report.json');

await ensureBenchmarkBuilt();
await rm(runBase, { recursive: true, force: true });
await mkdir(runBase, { recursive: true });

const common = {
  NEARBYTES_BENCH_BASE: runBase,
  NEARBYTES_BENCH_PROFILE: 'paper',
  NEARBYTES_BENCH_SKIP_FIGURES: '1',
  NEARBYTES_BENCH_DISCOVERY_MS: '2000',
  NEARBYTES_BENCH_GRACE_MS: '3000',
  NEARBYTES_BENCH_LATENCY_TIMEOUT_MS: '0',
  NEARBYTES_BENCH_THROUGHPUT_TIMEOUT_MS: '0',
  NEARBYTES_BENCH_TRIAL_ACK_MS: '0',
  NEARBYTES_BENCH_SYNC_READY_MS: '0',
  NEARBYTES_BENCH_SWARM_TIMEOUT_MS: '0',
};

console.log(`\n═══ paper profile (workdir ${runBase}) ═══\n`);

const bob = spawnBench('bob', {
  ...common,
  NEARBYTES_BENCH_ROLE: 'receiver',
  NEARBYTES_BENCH_OUT: path.join(runBase, 'bob/benchmark-result.json'),
});
await sleep(250);
const alice = spawnBench('alice', {
  ...common,
  NEARBYTES_BENCH_ROLE: 'sender',
  NEARBYTES_BENCH_OUT: path.join(runBase, 'alice/benchmark-result.json'),
});

await Promise.all([bob.wait(), alice.wait()]);

await mkdir(reportDir, { recursive: true });
await new Promise((res, rej) => {
  const m = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'scripts/merge-benchmark-results.mjs'),
      '--sender',
      path.join(runBase, 'alice/benchmark-result.json'),
      '--manifest',
      path.join(runBase, 'alice/trial-manifest.json'),
      '--receiver',
      path.join(runBase, 'bob/benchmark-result.json'),
      '--out',
      reportPath,
      '--topology',
      'localhost paper profile (alice sender, bob receiver)',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  m.on('exit', (c) => (c === 0 ? res() : rej(new Error(`merge exit ${c}`))));
});

const report = await readBenchReport(reportPath);
printBenchReport(report, {
  title: 'e2e:paper:local complete',
  reportPath,
});
console.log(`  figures: yarn paper:figures --report ${reportPath}\n`);
