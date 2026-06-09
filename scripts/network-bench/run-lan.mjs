#!/usr/bin/env node
/**
 * LAN-category network benchmark.
 *
 *   yarn bench:network:lan             # full sweep (~90s including deploy)
 *   yarn bench:network:lan --out path  # custom JSON destination
 *
 * Topology:
 *   Mac (control plane) ──ssh──┐         ┌──ssh── Mac
 *                              ▼         ▼
 *   pc-ciancia (alice) ◀═══════ LAN ═══════▶ zombie (bob)
 *                          (data path)
 *
 * The Mac only multiplexes JSON commands; all bytes flow alice⇄bob over
 * the LAN. Baselines (scp, rsync) run **on alice** so the comparison is
 * apples-to-apples — Nearbytes and scp/rsync share the same wire.
 *
 * For each size class (small, large, burst) we run K measured repeats of:
 *   - nearbytes (mDNS-discovered TCP, encrypted + hashed + journalled)
 *   - scp       (OpenSSH transfer, encrypted)
 *   - rsync     (`-W --inplace`, OpenSSH transport, no delta)
 *
 * Output: JSON at `.local/bench/network/lan-results.json` with the same
 * shape as run-local.mjs's output, plus `machines: { local, alice, bob }`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { collectLocalHostInfo, collectRemoteHostInfo } from './lib/hostinfo.mjs';
import { loadHosts, requireLan } from './lib/hosts.mjs';
import { SIZES, REPEATS, describeSize, totalBytes } from './lib/sizes.mjs';
import { shouldTakeAnotherNetworkRep } from '../lib/bench-timing.mjs';
import { ensureRemoteWorkspace } from './lib/deploy.mjs';
import { ensureAlicePayload, lanScp, lanRsync } from './lib/baselines.mjs';
import { NearbytesPair } from './lib/nearbytes-pair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT_PATH = arg('--out', join(REPO_ROOT, '.local/bench/network/lan-results.json'));
const SKIP_DEPLOY = process.argv.includes('--skip-deploy');

function fmtMs(ms) { return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`; }
function mbps(bytes, ms) { return ms > 0 ? Number(((bytes * 8) / ms / 1000).toFixed(1)) : 0; }
function quantiles(xs) {
  const v = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
  return { n: v.length, min: v[0], p50: q(50), p95: q(95), max: v[v.length - 1], mean: v.reduce((a, b) => a + b, 0) / v.length };
}

async function ensurePayloads(aliceHost, plan, sizeClass) {
  const paths = [];
  for (let i = 0; i < plan.count; i++) {
    const name = `${sizeClass}-${i}.bin`;
    paths.push(await ensureAlicePayload(aliceHost, name, plan.bytes, i + 1));
  }
  return paths;
}

async function runOneNearbytes(pair, plan, burst) {
  const files = Array.from({ length: plan.count }, () => ({ bytes: plan.bytes }));
  const r = await pair.measure({ files, burst, timeoutMs: 120_000 });
  return {
    wallMs: r.wallMs,
    bytes: totalBytes(plan),
    count: plan.count,
    perStream: r.perStream,
    publishWallMs: r.publishWallMs,
  };
}

async function runSizeClass({ pair, aliceHost, bobHost, sizeClass, plan, repeats }) {
  console.log(`\n── ${sizeClass} (${describeSize(plan)}) ──`);
  const systems = ['scp', 'rsync', 'nearbytes'];
  const results = Object.fromEntries(systems.map((s) => [s, []]));
  const perStreamAll = [];

  const alicePaths = await ensurePayloads(aliceHost, plan, sizeClass);

  let totalMeasuredMs = 0;
  let measured = 0;
  for (let rep = 0; rep < repeats.warmup + repeats.measured; rep++) {
    const isWarmup = rep < repeats.warmup;
    if (!isWarmup && measured >= repeats.measured) break;
    if (!isWarmup && measured > 0 && !shouldTakeAnotherNetworkRep({ totalMeasuredMs })) break;
    const tag = isWarmup ? `warmup ${rep + 1}/${repeats.warmup}` : `measured ${measured + 1}/${repeats.measured}`;
    let line = `  ${tag.padEnd(14)} `;
    let repWallMs = 0;
    for (const sys of systems) {
      try {
        const m = sys === 'scp'
          ? { ...(await lanScp(aliceHost, bobHost, alicePaths)), bytes: totalBytes(plan) }
          : sys === 'rsync'
          ? { ...(await lanRsync(aliceHost, bobHost, alicePaths)), bytes: totalBytes(plan) }
          : await runOneNearbytes(pair, plan, sizeClass === 'burst');
        repWallMs = Math.max(repWallMs, m.wallMs);
        if (!isWarmup) {
          results[sys].push({ wallMs: m.wallMs, goodputMbps: mbps(m.bytes, m.wallMs) });
          if (sys === 'nearbytes' && m.perStream) perStreamAll.push(m.perStream);
        }
        line += `${sys}=${fmtMs(m.wallMs).padStart(8)} (${String(mbps(m.bytes, m.wallMs)).padStart(7)} Mb/s)  `;
      } catch (err) {
        line += `${sys}=FAIL  `;
        console.error(`    ${sys} failed: ${err.message}`);
      }
    }
    if (!isWarmup) {
      measured++;
      totalMeasuredMs += repWallMs;
    }
    console.log(line);
  }

  return {
    sizeClass,
    sizeBytes: plan.bytes,
    count: plan.count,
    aggregateBytes: totalBytes(plan),
    systems: Object.fromEntries(
      Object.entries(results).map(([k, runs]) => [
        k,
        {
          runs,
          wallMs: quantiles(runs.map((r) => r.wallMs)),
          goodputMbps: quantiles(runs.map((r) => r.goodputMbps)),
          perStream: k === 'nearbytes' ? perStreamAll : undefined,
        },
      ]),
    ),
  };
}

process.on('unhandledRejection', (err) => { console.error('UNHANDLED REJECTION:', err); process.exit(2); });
process.on('uncaughtException', (err) => { console.error('UNCAUGHT EXCEPTION:', err); process.exit(2); });

async function main() {
  console.log(`network-bench / category=lan (pid=${process.pid})\n`);

  const hosts = await loadHosts();
  const lan = requireLan(hosts);
  console.log(`hosts: alice=${lan.alice.ssh} (${lan.alice.label}) ↔ bob=${lan.bob.ssh} (${lan.bob.label})`);

  if (!SKIP_DEPLOY) {
    console.log('\ndeploying nearbytes to both LAN hosts…');
    await Promise.all([
      ensureRemoteWorkspace(lan.alice.ssh, lan.alice.workdir),
      ensureRemoteWorkspace(lan.bob.ssh, lan.bob.workdir),
    ]);
  } else {
    console.log('skipping deploy (--skip-deploy)');
  }

  console.log('\ncollecting host info…');
  const [hostLocal, hostAlice, hostBob] = await Promise.all([
    collectLocalHostInfo(),
    collectRemoteHostInfo(lan.alice.ssh),
    collectRemoteHostInfo(lan.bob.ssh),
  ]);
  for (const [tag, h] of Object.entries({ local: hostLocal, alice: hostAlice, bob: hostBob })) {
    console.log(
      `  ${tag.padEnd(7)} ${h.osName} ${h.osVersion} (${h.kernel}) ${h.cpuModel} ${h.cpuPhysicalCores}p/${h.cpuLogicalCores}l, ${h.memTotalGiB} GiB`,
    );
  }

  const t0 = Date.now();
  console.log('\nstarting nearbytes pair (alice@pc-ciancia + bob@zombie)…');
  const pair = await NearbytesPair.startRemote(lan.alice, lan.bob, { readyTimeoutMs: 180000, discovery: 'mdns' });
  console.log(`pair ready: friend session alice=${pair.friendMs.alice}ms bob=${pair.friendMs.bob}ms`);

  let sizeClasses;
  try {
    const onlyClasses = (process.env.NEARBYTES_NETBENCH_CLASSES || 'small,large,burst').split(',');
    sizeClasses = [];
    for (const sizeClass of onlyClasses) {
      const out = await runSizeClass({
        pair,
        aliceHost: lan.alice,
        bobHost: lan.bob,
        sizeClass,
        plan: SIZES.lan[sizeClass],
        repeats: REPEATS.lan,
      });
      sizeClasses.push(out);
    }
  } finally {
    await pair.stop();
  }

  const report = {
    category: 'lan',
    generatedAt: new Date().toISOString(),
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    machines: { local: hostLocal, alice: hostAlice, bob: hostBob },
    aliceHost: { label: lan.alice.label, ssh: lan.alice.ssh, ip: lan.alice.ip },
    bobHost: { label: lan.bob.label, ssh: lan.bob.ssh, ip: lan.bob.ip },
    friendSessionMs: pair.friendMs,
    repeats: REPEATS.lan,
    plans: SIZES.lan,
    sizeClasses,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${OUT_PATH} (${report.wallSeconds}s wall)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
