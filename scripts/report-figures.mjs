#!/usr/bin/env node
/**
 * Render LaTeX tables/figures from an existing bench JSON report. Does not
 * run benchmarks.
 *
 *   yarn report:figures
 *   yarn report:figures --report .local/bench/reports/e2e-campaign/latest/bench-campaign-report.json
 *   yarn report:figures --outdir /path/to/external/figures
 *
 * The output directory can also be set via the `NEARBYTES_REPORT_FIGURES_DIR`
 * environment variable. By default figures land under
 * `.local/bench/figures/` inside this repo so the benchmarks repo has no
 * hard dependency on any other repository.
 */

import { access } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readBenchReport } from './bench-json.mjs';
import { printBenchReport } from './bench-report-print.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultFigures =
  process.env['NEARBYTES_REPORT_FIGURES_DIR'] ??
  path.join(repoRoot, '.local/bench/figures');
const defaultReport = path.join(
  repoRoot,
  '.local/bench/reports/e2e-campaign/latest/bench-campaign-report.json',
);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`))));
  });
}

const reportPath = path.resolve(arg('--report', defaultReport));
const outDir = path.resolve(arg('--outdir', defaultFigures));

try {
  await access(reportPath);
} catch {
  console.error(`\nreport:figures: report not found:\n  ${reportPath}\n`);
  console.error('Run a benchmark first, e.g. yarn e2e:campaign:multi or yarn bench:campaign\n');
  process.exit(1);
}

const report = await readBenchReport(reportPath);
printBenchReport(report, { title: 'Source report (report:figures)', reportPath });

await runNode([
  path.join(repoRoot, 'scripts/render-benchmark-figures.mjs'),
  '--report',
  reportPath,
  '--outdir',
  outDir,
]);

console.log(`\n═══ report:figures complete ═══`);
console.log(`  JSON:    ${reportPath}`);
console.log(`  LaTeX:   ${outDir}\n`);
