#!/usr/bin/env node
/**
 * Leave-one-out ablation of runtime optimizations (local loopback).
 *
 *   yarn bench:opt-ablation
 *   yarn bench:opt-ablation -- --cases 128MiB_x1_seq --target-ms 15000
 *   yarn bench:opt-ablation -- --opt-off overlap-expect   # disable one flag (others stay on)
 *
 * Records per-rep phase timelines (bulk-recv-phases markers; no extra hot-path work).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { DEFAULT_BENCH_TARGET_MS } from '../lib/local-config.mjs';
import { resolveBenchRepeatBudget, shouldTakeAnotherBenchRep } from '../lib/bench-timing.mjs';
import { aggregateTimelines } from '../lib/phase-timeline.mjs';
import { ablationConfigs, envForOpts, OPT_DEFS } from '../lib/optimization-flags.mjs';
import { ensureProtocolPeerBuilt, killStrayProtocolPeers, ProtocolPair } from './lib/protocol-pair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const MIB = 1024 * 1024;

const CASES = [
  { label: '64MiB_4MiB_x16_burst', count: 16, bytes: 4 * MIB, burst: true },
  { label: '128MiB_x1_seq', count: 1, bytes: 128 * MIB, burst: false },
  { label: '64MiB_512KiB_x128_burst', count: 128, bytes: 512 * 1024, burst: true },
];

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const { targetMs, maxRepeats } = resolveBenchRepeatBudget({
  targetMs: arg('--target-ms', process.env.NEARBYTES_ABLATION_TARGET_MS ?? String(DEFAULT_BENCH_TARGET_MS)),
  maxRepeats: arg('--max-repeats', process.env.NEARBYTES_ABLATION_MAX_REPEATS ?? '4'),
  label: 'opt-ablation',
});
const outPath = arg('--out', join(REPO_ROOT, '.local/bench/protocol/opt-ablation-local.json'));
const caseFilter = arg('--cases', '').split(',').map((s) => s.trim()).filter(Boolean);
const skipBuild = process.argv.includes('--skip-build');

function mbps(bytes, ms) {
  return ms > 0 ? (bytes * 8) / (ms * 1000) : 0;
}

function log(msg) {
  process.stderr.write(`[opt-ablation] ${msg}\n`);
}

function selectedCases() {
  if (caseFilter.length === 0) return CASES;
  const picked = CASES.filter((c) => caseFilter.includes(c.label));
  if (picked.length === 0) throw new Error(`--cases matched nothing`);
  return picked;
}

async function measureRepeated(plan, env) {
  const prev = { ...process.env };
  Object.assign(process.env, env);
  const runs = [];
  let totalMs = 0;
  let totalBytes = 0;
  const base = join(REPO_ROOT, '.local/bench/protocol/ablation', plan.label);
  killStrayProtocolPeers();
  let pair = await ProtocolPair.startLocal(base, { readyTimeoutMs: 180000, friendMs: 120000 });
  try {
    while (shouldTakeAnotherBenchRep({ runs, totalMs, targetMs, maxRepeats })) {
      if (runs.length > 0) {
        await pair.alice.exit().catch(() => {});
        await pair.bob.exit().catch(() => {});
        killStrayProtocolPeers();
        await new Promise((r) => setTimeout(r, 500));
        pair = await ProtocolPair.startLocal(base, { readyTimeoutMs: 180000, friendMs: 120000 });
      }
      const files = Array.from({ length: plan.count }, () => ({ bytes: plan.bytes }));
      const timeoutMs = Math.min(120_000, Math.max(30_000, (plan.count * plan.bytes) / MIB * 2000 + 15_000));
      let r;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          r = await pair.measureFiles({ files, timeoutMs, burst: plan.burst, caseTag: `${plan.label}-r${runs.length}` });
          break;
        } catch (err) {
          if (attempt === 2 || !/peer-stalled|timeout/i.test(String(err?.message))) throw err;
          log(`${plan.label} rep ${runs.length + 1} retry after ${err.message}`);
          await pair.alice.exit().catch(() => {});
          await pair.bob.exit().catch(() => {});
          killStrayProtocolPeers();
          pair = await ProtocolPair.startLocal(base, { readyTimeoutMs: 180000, friendMs: 120000 });
        }
      }
      runs.push({
        wallMs: r.wallMs,
        bytes: r.bytes,
        goodputMbps: r.goodputMbps,
        publishWallMs: r.publishWallMs,
        timeline: r.timeline,
      });
      totalMs += r.wallMs;
      totalBytes += r.bytes;
      log(`${plan.label} rep ${runs.length}: ${r.goodputMbps.toFixed(2)} Mb/s`);
    }
  } finally {
    await pair.alice.exit().catch(() => {});
    await pair.bob.exit().catch(() => {});
    Object.assign(process.env, prev);
  }
  return {
    repeats: runs.length,
    wallMs: Math.round(totalMs),
    bytes: totalBytes,
    goodputMbps: mbps(totalBytes, totalMs),
    targetReached: totalMs >= targetMs,
    runs,
  };
}

function buildStack() {
  const codeRoot = resolve(REPO_ROOT, '..');
  const steps = [
    ['nearbytes-sync', codeRoot],
    ['nearbytes-engine', codeRoot],
    [REPO_ROOT, REPO_ROOT],
  ];
  for (const [name, root] of steps) {
    const dir = name === REPO_ROOT ? REPO_ROOT : join(root, name);
    log(`build ${name}`);
    const r = spawnSync('yarn', ['build'], { cwd: dir, stdio: 'inherit', shell: true });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/lib/propagate-sibling-dist.mjs')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  ensureProtocolPeerBuilt();
}

async function main() {
  if (!skipBuild) buildStack();

  const configs = ablationConfigs();
  const cases = selectedCases();
  const report = {
    generatedAt: new Date().toISOString(),
    targetMs,
    maxRepeats,
    category: 'local',
    optimizations: OPT_DEFS.map((d) => ({ id: d.id, env: d.env, sync: d.sync })),
    cases: cases.map((c) => ({ label: c.label, count: c.count, bytes: c.bytes, burst: c.burst })),
    results: [],
  };

  for (const cfg of configs) {
    const env = envForOpts(cfg.disabled);
    log(`config ${cfg.id} (disabled: ${[...cfg.disabled].join(', ') || 'none'})`);
    const row = { configId: cfg.id, label: cfg.label, disabled: [...cfg.disabled], cases: {} };
    for (const plan of cases) {
      const measured = await measureRepeated(plan, env);
      const timelines = measured.runs.map((r) => r.timeline).filter(Boolean);
      row.cases[plan.label] = {
        ...measured,
        timelineAgg: timelines.length ? aggregateTimelines(timelines) : null,
      };
    }
    report.results.push(row);
  }

  for (const plan of cases) {
    const baseline = report.results.find((r) => r.configId === 'all-on')?.cases[plan.label]?.goodputMbps;
    if (baseline == null) continue;
    for (const row of report.results) {
      const g = row.cases[plan.label]?.goodputMbps;
      if (g == null) continue;
      row.cases[plan.label].deltaMbps = Number((g - baseline).toFixed(2));
      row.cases[plan.label].deltaPct = baseline > 0 ? Number((((g - baseline) / baseline) * 100).toFixed(2)) : 0;
    }
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2));
  log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
