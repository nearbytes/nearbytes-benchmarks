#!/usr/bin/env node
/**
 * WAN-category network benchmark — REAL WAN, no simulation.
 *
 *   yarn bench:network:wan              # full sweep
 *   yarn bench:network:wan --skip-deploy
 *
 * Topology:
 *           ┌──── ssh ────┐
 *           ▼             ▼
 *   this-mac (alice) ═══ Internet ═══▶ zombie (bob)
 *                    (~42 ms RTT to ISTI-CNR Pisa,
 *                     direct TCP, no tc netem)
 *
 * The Mac is the alice peer AND the orchestrator. Bytes flow over the
 * actual public Internet path between the Mac and bob; the only thing
 * the SSH session carries is the JSON command protocol to bob, plus
 * (for baselines) the scp/rsync streams themselves.
 *
 * Baselines run from the Mac to bob (the realistic user-facing pattern
 * for a WAN transfer: `scp file remote:` from your laptop).
 *
 * Output: JSON at `.local/bench/network/wan-results.json` with the same
 * shape as run-local.mjs / run-lan.mjs.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

import { collectLocalHostInfo, collectRemoteHostInfo } from './lib/hostinfo.mjs';
import { loadHosts, requireWan } from './lib/hosts.mjs';
import { SIZES, REPEATS, describeSize, totalBytes } from './lib/sizes.mjs';
import { ensureRemoteWorkspace } from './lib/deploy.mjs';
import {
  remoteScp, remoteRsync, mkScratch, cleanScratch, prepareRemoteDir, SshMaster,
} from './lib/baselines.mjs';
import { writeDeterministicPayload } from './lib/payload.mjs';
import { NearbytesPair, ensurePeerBuilt } from './lib/nearbytes-pair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT_PATH = arg('--out', join(REPO_ROOT, '.local/bench/network/wan-results.json'));
const SKIP_DEPLOY = process.argv.includes('--skip-deploy');

/**
 * 8 ICMP pings (best-of-N over a single second) — the canonical way to
 * report what a WAN path looks like. Mirrored verbatim into the JSON
 * report so figure builders can annotate plots with the actual RTT
 * rather than a hand-edited assumption.
 */
async function resolveSshHostname(sshAlias) {
  return new Promise((resolveP) => {
    const child = spawn('ssh', ['-G', sshAlias], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (c) => (buf += c.toString()));
    child.on('close', () => {
      const m = buf.match(/^hostname\s+(\S+)/m);
      resolveP(m ? m[1] : sshAlias);
    });
    child.on('error', () => resolveP(sshAlias));
  });
}

async function measureWanRtt(sshAlias) {
  const target = await resolveSshHostname(sshAlias);
  return new Promise((resolveP) => {
    const child = spawn('ping', ['-c', '8', '-i', '0.2', target], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (c) => (buf += c.toString()));
    child.on('close', () => {
      const rtts = [...buf.matchAll(/time[=<]\s*([\d.]+)\s*ms/g)].map((m) => Number(m[1]));
      const recv = (buf.match(/(\d+)\s+packets received|(\d+)\s+received/) || [])[1] || rtts.length;
      const sent = (buf.match(/(\d+)\s+packets transmitted/) || [])[1] || 8;
      const lossFrac = sent > 0 ? 1 - Number(recv) / Number(sent) : 0;
      if (rtts.length === 0) return resolveP({ n: 0, minMs: 0, meanMs: 0, maxMs: 0, stddevMs: 0, lossFrac });
      const minMs = Math.min(...rtts);
      const maxMs = Math.max(...rtts);
      const meanMs = rtts.reduce((a, b) => a + b, 0) / rtts.length;
      const variance = rtts.reduce((a, b) => a + (b - meanMs) ** 2, 0) / rtts.length;
      resolveP({ n: rtts.length, minMs, meanMs, maxMs, stddevMs: Math.sqrt(variance), lossFrac });
    });
  });
}

function fmtMs(ms) { return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`; }
function mbps(bytes, ms) { return ms > 0 ? Number(((bytes * 8) / ms / 1000).toFixed(1)) : 0; }
function quantiles(xs) {
  const v = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
  return { n: v.length, min: v[0], p50: q(50), p95: q(95), max: v[v.length - 1], mean: v.reduce((a, b) => a + b, 0) / v.length };
}

function buildFiles(plan, scratch, sizeClassName) {
  const out = [];
  for (let i = 0; i < plan.count; i++) {
    const name = `${sizeClassName}-${i}`;
    const path = join(scratch, `${name}.bin`);
    writeDeterministicPayload(path, plan.bytes, i + 1);
    out.push({ name, path, bytes: plan.bytes });
  }
  return out;
}

async function runOneNearbytes(pair, plan, burst) {
  const files = Array.from({ length: plan.count }, () => ({ bytes: plan.bytes }));
  const r = await pair.measure({ files, burst, timeoutMs: 300_000 });
  return {
    wallMs: r.wallMs,
    bytes: totalBytes(plan),
    count: plan.count,
    perStream: r.perStream,
    publishWallMs: r.publishWallMs,
  };
}

async function runSizeClass({ pair, bobHost, sshMaster, sizeClass, plan, scratchBase, repeats }) {
  console.log(`\n── ${sizeClass} (${describeSize(plan)}) ──`);
  const systems = ['scp', 'rsync', 'nearbytes'];
  const results = Object.fromEntries(systems.map((s) => [s, []]));
  const perStreamAll = [];
  const bobBaselineDir = `${bobHost.workdir}/baselines-recv`;

  for (let rep = 0; rep < repeats.warmup + repeats.measured; rep++) {
    const isWarmup = rep < repeats.warmup;
    const tag = isWarmup ? `warmup ${rep + 1}/${repeats.warmup}` : `measured ${rep - repeats.warmup + 1}/${repeats.measured}`;
    const scratch = `${scratchBase}-${rep}`;
    await mkdir(scratch, { recursive: true });
    const files = buildFiles(plan, scratch, sizeClass);
    let line = `  ${tag.padEnd(14)} `;
    for (const sys of systems) {
      try {
        if (sys === 'scp' || sys === 'rsync') {
          await prepareRemoteDir(bobHost.ssh, bobBaselineDir, { master: sshMaster });
        }
        const m = sys === 'scp'
          ? { ...(await remoteScp(files, bobHost.ssh, bobBaselineDir, { master: sshMaster })), bytes: totalBytes(plan) }
          : sys === 'rsync'
          ? { ...(await remoteRsync(files, bobHost.ssh, bobBaselineDir, { master: sshMaster })), bytes: totalBytes(plan) }
          : await runOneNearbytes(pair, plan, sizeClass === 'burst');
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
    console.log(line);
    cleanScratch(scratch);
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
  console.log(`network-bench / category=wan (pid=${process.pid})\n`);
  await ensurePeerBuilt();

  const hosts = await loadHosts();
  const wan = requireWan(hosts);
  console.log(`hosts: alice=this-mac ↔ bob=${wan.bob.ssh} (${wan.bob.label})`);

  if (!SKIP_DEPLOY) {
    console.log('\ndeploying nearbytes to bob…');
    await ensureRemoteWorkspace(wan.bob.ssh, wan.bob.workdir);
  } else {
    console.log('skipping deploy (--skip-deploy)');
  }

  console.log('\ncollecting host info + measuring WAN RTT…');
  const [hostLocal, hostBob, rttSummary] = await Promise.all([
    collectLocalHostInfo(),
    collectRemoteHostInfo(wan.bob.ssh),
    measureWanRtt(wan.bob.ssh),
  ]);
  for (const [tag, h] of Object.entries({ local: hostLocal, bob: hostBob })) {
    console.log(
      `  ${tag.padEnd(7)} ${h.osName} ${h.osVersion} (${h.kernel}) ${h.cpuModel} ${h.cpuPhysicalCores}p/${h.cpuLogicalCores}l, ${h.memTotalGiB} GiB`,
    );
  }
  console.log(`  WAN RTT: min=${rttSummary.minMs.toFixed(2)} mean=${rttSummary.meanMs.toFixed(2)} max=${rttSummary.maxMs.toFixed(2)} ms (n=${rttSummary.n}, loss=${(100 * rttSummary.lossFrac).toFixed(0)}%)`);

  const t0 = Date.now();
  const scratchBase = mkScratch();
  const peerBase = join(REPO_ROOT, '.local/bench/network/wan-peer');

  console.log('\nopening SSH ControlMaster to bob (single persistent connection)…');
  const sshMaster = new SshMaster(wan.bob.ssh);
  await sshMaster.start();
  console.log(`  master socket: ${sshMaster.sock}`);

  console.log('\nstarting nearbytes pair (alice=this-mac + bob@zombie)…');
  const pair = await NearbytesPair.startHybrid(peerBase, wan.bob, { readyTimeoutMs: 240000 });
  console.log(`pair ready: friend session alice=${pair.friendMs.alice}ms bob=${pair.friendMs.bob}ms`);

  let sizeClasses;
  try {
    const onlyClasses = (process.env.NEARBYTES_NETBENCH_CLASSES || 'small,large,burst').split(',');
    sizeClasses = [];
    for (const sizeClass of onlyClasses) {
      const out = await runSizeClass({
        pair,
        bobHost: wan.bob,
        sshMaster,
        sizeClass,
        plan: SIZES.wan[sizeClass],
        scratchBase: join(scratchBase, sizeClass),
        repeats: REPEATS.wan,
      });
      sizeClasses.push(out);
    }
  } finally {
    await pair.stop();
    await sshMaster.stop();
    cleanScratch(scratchBase);
  }

  const report = {
    category: 'wan',
    generatedAt: new Date().toISOString(),
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    machines: { local: hostLocal, bob: hostBob },
    bobHost: { label: wan.bob.label, ssh: wan.bob.ssh },
    wanRttMs: rttSummary,
    friendSessionMs: pair.friendMs,
    repeats: REPEATS.wan,
    plans: SIZES.wan,
    sizeClasses,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${OUT_PATH} (${report.wallSeconds}s wall)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
