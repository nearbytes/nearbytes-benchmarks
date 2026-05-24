#!/usr/bin/env node
/**
 * Print a human-readable benchmark summary to the terminal.
 *
 *   node scripts/bench-report-print.mjs path/to/bench-report.json
 *   node scripts/bench-report-print.mjs path/to/bench-campaign-report.json
 */

import path from 'path';
import { fileURLToPath } from 'url';

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
import { readBenchReport } from './bench-json.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function fmtMs(v) {
  if (v == null || !Number.isFinite(v) || v < 0) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

function fmtMbps(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Number(v).toFixed(2)} Mb/s`;
}

function fmtCi(row, valueKey = 'mean') {
  const v = row[valueKey] ?? row.p50;
  if (row.ci95Low == null || row.ci95High == null || row.n <= 1) {
    return v != null ? String(typeof v === 'number' && v % 1 ? v.toFixed(2) : Math.round(v)) : '—';
  }
  return `${Math.round(row.ci95Low)}–${Math.round(row.ci95High)} (mean ${Math.round(row.mean ?? v)})`;
}

function line(char = '─', n = 72) {
  return char.repeat(n);
}

export function printBenchReport(report, opts = {}) {
  const { title = 'Benchmark report', reportPath = null } = opts;
  const isCampaign = report.profile === 'paper-campaign' || report.campaignSeeds != null;
  const latency = report.latencyTable ?? report.syncLatencyTable ?? [];
  const goodput = report.goodputTable ?? [];
  const publishCpu = report.publishCpuTable ?? [];
  const decomp = report.latencyDecompositionTable ?? [];

  console.log(`\n${line('═')}`);
  console.log(title);
  if (reportPath) console.log(`  ${reportPath}`);
  console.log(line());
  console.log(`  topology:  ${report.topology ?? '—'}`);
  console.log(`  profile:   ${report.profile ?? '—'}`);
  if (report.generatedAt) console.log(`  generated: ${report.generatedAt}`);
  if (isCampaign) {
    console.log(`  seeds:     ${report.campaignSeeds} (${(report.seedIds ?? []).join(', ') || '—'})`);
  }
  const sf = report.swarmFormation;
  if (sf) {
    const a = sf.sender?.p50 ?? sf.senderMs;
    const b = sf.receiver?.p50 ?? sf.receiverMs;
    if (a != null || b != null) {
      console.log(`  friend session p50:  Alice ${fmtMs(a)}  Bob ${fmtMs(b)}`);
    }
  }
  console.log(line());

  if (latency.length > 0) {
    console.log('\n  Latency (oneWayLatencyMs)');
    console.log('  ' + 'size'.padEnd(10) + 'n'.padStart(5) + 'p50'.padStart(10) + 'p95'.padStart(10) + '  95% CI (mean)');
    for (const r of latency) {
      console.log(
        '  ' +
          String(r.sizeLabel ?? r.sizeBytes).padEnd(10) +
          String(r.n ?? 0).padStart(5) +
          fmtMs(r.p50).padStart(10) +
          fmtMs(r.p95).padStart(10) +
          '  ' +
          fmtCi(r),
      );
    }
  }

  if (decomp.length > 0) {
    console.log('\n  Latency decomposition (p50)');
    console.log(
      '  ' +
        'size'.padEnd(10) +
        'total'.padStart(10) +
        'publish'.padStart(10) +
        'sync+rx'.padStart(10),
    );
    for (const r of decomp) {
      console.log(
        '  ' +
          String(r.sizeLabel ?? '').padEnd(10) +
          fmtMs(r.totalP50).padStart(10) +
          fmtMs(r.publishCpuP50).padStart(10) +
          fmtMs(r.syncTransferP50).padStart(10),
      );
    }
  }

  if (goodput.length > 0) {
    console.log('\n  Goodput (application-level)');
    console.log('  ' + 'stream'.padEnd(10) + 'n'.padStart(5) + 'mean'.padStart(12) + '  95% CI');
    for (const r of goodput) {
      const g = r.goodputMbps ?? r.mean;
      console.log(
        '  ' +
          String(r.sizeLabel ?? '').padEnd(10) +
          String(r.n ?? 0).padStart(5) +
          fmtMbps(g).padStart(12) +
          '  ' +
          (r.ci95Low != null ? `${r.ci95Low.toFixed(1)}–${r.ci95High.toFixed(1)} Mb/s` : '—'),
      );
    }
  }

  if (publishCpu.length > 0) {
    console.log('\n  Publish CPU (addFile path)');
    console.log('  ' + 'size'.padEnd(10) + 'n'.padStart(5) + 'p50'.padStart(10) + '  95% CI (mean)');
    for (const r of publishCpu) {
      console.log(
        '  ' +
          String(r.sizeLabel ?? '').padEnd(10) +
          String(r.n ?? 0).padStart(5) +
          fmtMs(r.p50).padStart(10) +
          '  ' +
          fmtCi(r),
      );
    }
  }

  const tp = report.throughput?.receiverGoodputMbps;
  if (tp != null && goodput.length === 0) {
    console.log(`\n  Primary stream goodput: ${fmtMbps(tp)}`);
  }

  console.log(`\n${line('═')}\n`);
}

const positional = process.argv[2];
const reportPath = arg(
  '--report',
  positional && !positional.startsWith('-') ? positional : null,
);
if (isMain && reportPath) {
  const report = await readBenchReport(path.resolve(reportPath));
  printBenchReport(report, {
    title: report.campaignSeeds != null ? 'Campaign benchmark' : 'Seed benchmark',
    reportPath: path.resolve(reportPath),
  });
}
