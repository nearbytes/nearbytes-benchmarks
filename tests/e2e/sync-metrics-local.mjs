#!/usr/bin/env node
/**
 * Same-machine latency + bandwidth smoke (alice + bob workdirs, reactive sync).
 *
 *   yarn e2e:local
 */

import { mkdir, rm, access } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { getBenchPaths, getRepoRoot } from './lib/config.mjs';
import { spawnBench, sleep } from './lib/spawn-bench.mjs';
import { ensureBenchmarkBuilt } from '../../scripts/ensure-built.mjs';

const LOCAL_BENCH_ENV = {
  NEARBYTES_BENCH_RECEIVE_TIMEOUT_MS: '12000',
  NEARBYTES_BENCH_DISCOVERY_MS: '2000',
  NEARBYTES_BENCH_GRACE_MS: '1500',
};
const PHASE_WALL_SEC = 50;

function spawnWithWall(role, envExtra) {
  const { child, wait } = spawnBench(role, envExtra);
  const wall = setTimeout(() => {
    console.error(`[${role}] phase wall ${PHASE_WALL_SEC}s — sending SIGTERM`);
    child.kill('SIGTERM');
  }, PHASE_WALL_SEC * 1000);
  return {
    wait: async () => {
      try {
        return await wait();
      } finally {
        clearTimeout(wall);
      }
    },
  };
}

const repoRoot = getRepoRoot();
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const paths = await getBenchPaths();
const runBase = path.join(paths.e2eWorkDir, runId);
const latencyReportDir = path.join(paths.benchReportsDir, 'e2e-local-latency');
const bandwidthReportDir = path.join(paths.benchReportsDir, 'e2e-local-bandwidth');

async function runPhase(label, profileEnv, reportDir) {
  const base = path.join(runBase, label);
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });

  const common = {
    NEARBYTES_BENCH_BASE: base,
    NEARBYTES_BENCH_SKIP_FIGURES: '1',
    ...LOCAL_BENCH_ENV,
    ...profileEnv,
  };

  console.log(`\n═══ ${label} (workdir ${base}) ═══\n`);

  const bob = spawnWithWall('bob', {
    ...common,
    NEARBYTES_BENCH_ROLE: 'receiver',
    NEARBYTES_BENCH_OUT: path.join(base, 'bob/benchmark-result.json'),
  });
  await sleep(250);
  const alice = spawnWithWall('alice', {
    ...common,
    NEARBYTES_BENCH_ROLE: 'sender',
    NEARBYTES_BENCH_OUT: path.join(base, 'alice/benchmark-result.json'),
  });

  await Promise.all([bob.wait(), alice.wait()]);

  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'bench-report.json');
  await new Promise((res, rej) => {
    const m = spawn(
      process.execPath,
      [
        path.join(repoRoot, 'scripts/merge-benchmark-results.mjs'),
        '--sender',
        path.join(base, 'alice/benchmark-result.json'),
        '--manifest',
        path.join(base, 'alice/trial-manifest.json'),
        '--receiver',
        path.join(base, 'bob/benchmark-result.json'),
        '--out',
        reportPath,
        '--topology',
        'localhost (alice sender, bob receiver)',
      ],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    m.on('exit', (c) => (c === 0 ? res() : rej(new Error(`merge exit ${c}`))));
  });

  return reportPath;
}

function printSummary(reportPath, title) {
  console.log(`\n── ${title} ──`);
  console.log(`Report: ${reportPath}`);
  return import('fs/promises').then((fs) =>
    fs.readFile(reportPath, 'utf-8').then((raw) => {
      const r = JSON.parse(raw);
      if (r.swarmFormation) {
        console.log(
          `Swarm: sender ${r.swarmFormation.senderMs ?? '—'} ms, receiver ${r.swarmFormation.receiverMs ?? '—'} ms`,
        );
      }
      if (r.syncLatencyTable?.length) {
        console.log('Sync latency (inbound-stored):');
        for (const row of r.syncLatencyTable) {
          console.log(`  ${row.sizeLabel}: p50 ${row.p50} ms (n=${row.n})`);
        }
      } else if (r.latencyTable?.length) {
        console.log('Latency:');
        for (const row of r.latencyTable) {
          console.log(`  ${row.sizeLabel}: p50 ${row.p50} ms`);
        }
      }
      if (r.throughput?.receiverGoodputMbps != null) {
        console.log(`Goodput: ${r.throughput.receiverGoodputMbps.toFixed(2)} Mb/s`);
      }
    }),
  );
}

await ensureBenchmarkBuilt();
await mkdir(paths.e2eWorkDir, { recursive: true });

const paperFigures = path.join(
  repoRoot,
  '..',
  '..',
  'NEARBYTES-PAPERS',
  'paper-nearbytes-hypercore',
  'figures',
);

const latencyReport = await runPhase('latency', { NEARBYTES_BENCH_PROFILE: 'latency-only' }, latencyReportDir);
await printSummary(latencyReport, 'Latency-only');

await new Promise((res, rej) => {
  const r = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'scripts/render-benchmark-figures.mjs'),
      '--report',
      latencyReport,
      '--outdir',
      paperFigures,
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  r.on('exit', (c) => (c === 0 ? res() : rej(new Error(`figures exit ${c}`))));
});
console.log(`LaTeX tables written to ${paperFigures}`);

const bandwidthReport = await runPhase(
  'bandwidth',
  { NEARBYTES_BENCH_QUICK: '1' },
  bandwidthReportDir,
);
await printSummary(bandwidthReport, 'Bandwidth (quick)');

console.log('\nE2E local metrics finished OK.\n');
