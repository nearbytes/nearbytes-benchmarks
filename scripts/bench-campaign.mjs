#!/usr/bin/env node
/**
 * Multi-seed campaign benchmark: build → run seeds (retry per slot) → aggregate → JSON + terminal.
 * Does not render LaTeX (use `yarn report:figures`).
 *
 *   yarn bench:campaign
 *   NEARBYTES_CAMPAIGN_SMOKE=1 yarn bench:campaign
 */

import { mkdir, rm, copyFile, symlink } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readBenchReport } from './bench-json.mjs';
import { printBenchReport } from './bench-report-print.mjs';
import { isWarmupTrialName } from './benchmark-stats.mjs';
import { killStaleBenchProcesses } from '../tests/e2e/lib/spawn-bench.mjs';
import { ensureBenchmarkBuilt } from './ensure-built.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SMOKE = ['1', 'true', 'yes'].includes(
  String(process.env['NEARBYTES_CAMPAIGN_SMOKE'] ?? '').toLowerCase(),
);
const TARGET_SEEDS = SMOKE
  ? 1
  : Math.max(1, Number(process.env['NEARBYTES_BENCH_CAMPAIGN_SEEDS'] ?? 5) || 5);
const campaignTrialsPerSeed = 5 * 5;
const smokeTrialsPerSeed = 5 * 2;
const MIN_VALID_TRIALS = Number(
  process.env['NEARBYTES_BENCH_MIN_VALID_TRIALS'] ??
    (SMOKE ? smokeTrialsPerSeed - 2 : campaignTrialsPerSeed - 2),
);
const MIN_GOODPUT_STREAMS = Number(process.env['NEARBYTES_BENCH_MIN_GOODPUT_STREAMS'] ?? 2);
const MAX_SEED_ATTEMPTS = Number(process.env['NEARBYTES_BENCH_MAX_SEED_ATTEMPTS'] ?? 3);

const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const campaignDir = path.join(repoRoot, '.local/bench/reports/e2e-campaign', runId);
const latestDir = path.join(repoRoot, '.local/bench/reports/e2e-campaign', 'latest');
const campaignReportPath = path.join(campaignDir, 'bench-campaign-report.json');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: repoRoot, stdio: 'inherit', ...opts });
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → exit ${c}`))));
  });
}


function countValidTrials(report) {
  return (report.mergedTrials ?? []).filter(
    (t) =>
      !isWarmupTrialName(t.name) &&
      t.oneWayLatencyMs != null &&
      t.oneWayLatencyMs >= 0 &&
      t.oneWayLatencyMs <= 10_000,
  ).length;
}

function countValidGoodputStreams(report) {
  return (report.goodputTable ?? []).filter(
    (r) => r.goodputMbps != null && Number.isFinite(r.goodputMbps) && r.goodputMbps > 0,
  ).length;
}

function seedPassesQC(report) {
  return (
    countValidTrials(report) >= MIN_VALID_TRIALS &&
    countValidGoodputStreams(report) >= MIN_GOODPUT_STREAMS
  );
}

async function runSeedAttempt(slot, attempt) {
  const seedDir = path.join(campaignDir, `seed-${slot}`);
  const workBase = path.join(seedDir, 'work');
  await rm(seedDir, { recursive: true, force: true });
  await mkdir(workBase, { recursive: true });

  const env = {
    ...process.env,
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
    NEARBYTES_BENCH_INTER_SEED_MS: '0',
    NEARBYTES_BENCH_MERGE_QUIET: '1',
  };
  if (SMOKE) {
    env['NEARBYTES_BENCH_LATENCY_REPEATS'] = '2';
    env['NEARBYTES_BENCH_STREAM_SIZES'] = '1048576,4194304';
  }

  console.log(`\n── seed slot ${slot} attempt ${attempt}/${MAX_SEED_ATTEMPTS} ──\n`);

  await run('node', ['tests/e2e/lib/run-campaign-seed.mjs'], {
    env: {
      ...env,
      NEARBYTES_CAMPAIGN_SEED_DIR: seedDir,
      NEARBYTES_CAMPAIGN_WORK_BASE: workBase,
    },
  });

  const reportPath = path.join(seedDir, 'bench-report.json');
  const report = await readBenchReport(reportPath);
  const ok = seedPassesQC(report);
  console.log(
    `  QC: latency ${countValidTrials(report)}/${MIN_VALID_TRIALS}+, goodput streams ${countValidGoodputStreams(report)}/${MIN_GOODPUT_STREAMS}+ → ${ok ? 'PASS' : 'FAIL'}`,
  );
  return { ok, reportPath, report };
}

async function publishLatest(reportPath) {
  await rm(latestDir, { recursive: true, force: true });
  await mkdir(latestDir, { recursive: true });
  await copyFile(reportPath, path.join(latestDir, 'bench-campaign-report.json'));
  try {
    await symlink(campaignDir, path.join(latestDir, 'run'), 'dir');
  } catch (err) {
    console.warn('[bench:campaign] latest symlink:', err.message);
  }
}

async function main() {
  console.log(
    SMOKE
      ? 'bench:campaign (SMOKE — 1 seed, 2 stream sizes)'
      : `bench:campaign (${TARGET_SEEDS} seeds, campaign profile)`,
  );

  await ensureBenchmarkBuilt();
  killStaleBenchProcesses();
  await mkdir(campaignDir, { recursive: true });

  const accepted = [];
  for (let slot = 1; slot <= TARGET_SEEDS; slot++) {
    let passed = false;
    for (let attempt = 1; attempt <= MAX_SEED_ATTEMPTS; attempt++) {
      try {
        const { ok } = await runSeedAttempt(slot, attempt);
        if (ok) {
          accepted.push(slot);
          passed = true;
          break;
        }
      } catch (err) {
        console.error(`  attempt ${attempt} error: ${err.message}`);
      }
    }
    if (!passed) {
      console.error(`  seed slot ${slot}: failed after ${MAX_SEED_ATTEMPTS} attempts`);
    }
  }

  if (accepted.length === 0) {
    throw new Error(
      `No seed passed QC (${MIN_VALID_TRIALS}+ latency trials, ${MIN_GOODPUT_STREAMS}+ goodput streams). See ${campaignDir}`,
    );
  }

  await run('node', [
    'scripts/aggregate-campaign.mjs',
    '--indir',
    campaignDir,
    '--out',
    campaignReportPath,
    '--topology',
    `localhost campaign (${accepted.length}/${TARGET_SEEDS} seeds accepted)`,
    '--min-valid-trials',
    String(MIN_VALID_TRIALS),
  ]);

  await publishLatest(campaignReportPath);

  const summary = await readBenchReport(campaignReportPath);
  printBenchReport(summary, {
    title: `bench:campaign complete (${accepted.length}/${TARGET_SEEDS} seeds)`,
    reportPath: campaignReportPath,
  });
  console.log(`  latest:  ${path.join(latestDir, 'bench-campaign-report.json')}`);
  console.log(`  figures: yarn report:figures\n`);
}

main().catch((err) => {
  console.error(`\nbench:campaign failed: ${err.message}\n`);
  process.exit(1);
});
