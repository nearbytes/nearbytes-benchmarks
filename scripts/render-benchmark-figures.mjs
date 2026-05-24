#!/usr/bin/env node
/**
 * Render LaTeX fragments for the paper from bench-report.json
 *
 *   node scripts/render-benchmark-figures.mjs --report bench-report.json --outdir ../paper-nearbytes-hypercore/figures
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import {
  PGF_PREAMBLE,
  COLORS,
  plotCoords,
  seriesCoords,
  axisMiBOpts,
  panelAxis,
  hasErrorBars,
  miB,
} from './benchmark-figure-lib.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function esc(s) {
  return String(s)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/[&%$#_{}]/g, (c) => `\\${c}`)
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function fmtMs(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '---';
  const n = Number(v);
  if (n < 0) return '---';
  return n >= 1000 ? `${(n / 1000).toFixed(2)}\\,s` : `${Math.round(n)}\\,ms`;
}

function fmtMbps(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '---';
  return `${Number(v).toFixed(1)}`;
}

const reportPath = arg('--report', 'bench-report.json');
const outDir = arg('--outdir', path.join(process.cwd(), '.local/bench/reports/tex'));
const report = JSON.parse(await readFile(reportPath, 'utf-8'));

await mkdir(outDir, { recursive: true });

const topology = esc(report.topology ?? 'two peers');
function tableFromMerged(report) {
  const bySize = new Map();
  for (const t of report.mergedTrials ?? []) {
    const v = t.oneWayLatencyMs ?? t.syncLatencyMs ?? t.listLatencyMs;
    if (v === null || v === undefined || !Number.isFinite(v) || v < 0) continue;
    if (!bySize.has(t.sizeBytes)) bySize.set(t.sizeBytes, []);
    bySize.get(t.sizeBytes).push(v);
  }
  const stats = (values) => {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (v.length === 0) return null;
    const sum = v.reduce((a, b) => a + b, 0);
    const p = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
    return { n: v.length, min: v[0], p50: p(50), p95: p(95), max: v[v.length - 1], mean: sum / v.length };
  };
  return [...bySize.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sizeBytes, values]) => {
      const s = stats(values);
      return {
        sizeBytes,
        sizeLabel:
          sizeBytes >= 1024 * 1024
            ? `${sizeBytes / (1024 * 1024)} MiB`
            : `${sizeBytes / 1024} KiB`,
        ...s,
      };
    })
    .filter((r) => r.n > 0);
}

const latencySource =
  (report.syncLatencyTable?.length ?? 0) > 0
    ? report.syncLatencyTable
    : (report.latencyTable?.length ?? 0) > 0
      ? report.latencyTable
      : tableFromMerged(report);

function fmtCi(r) {
  if (
    r.ci95Low === null ||
    r.ci95Low === undefined ||
    r.ci95High === null ||
    r.ci95High === undefined
  ) {
    return '---';
  }
  const lo = Math.max(0, r.ci95Low);
  const hi = r.ci95High;
  if (hi - lo < 1) return `$${Math.round(r.mean)}$`;
  return `$${Math.round(lo)}$--$${Math.round(hi)}$`;
}

const hasCi = latencySource.some((r) => r.ci95Low !== undefined && r.n > 1);
const latencyRows = latencySource
  .map((r) =>
    hasCi
      ? `${esc(r.sizeLabel)} & ${r.n ?? 0} & ${fmtMs(r.p50)} & ${fmtMs(r.p95)} & ${fmtCi(r)} \\\\`
      : `${esc(r.sizeLabel)} & ${r.n ?? 0} & ${fmtMs(r.p50)} & ${fmtMs(r.p95)} & ${fmtMs(r.mean)} \\\\`,
  )
  .join('\n');

const latencyCaption =
  report.profile === 'bidirectional-1mib'
    ? `Bidirectional friend carriage (Implementation~0): encrypted ${esc(topology)}. One-way receive latency is wall-clock from peer \\texttt{addFile} to local \\texttt{listFiles} ($n$ per direction).`
    : report.profile === 'paper'
      ? `One-way convergence latency (${esc(topology)}, \\textbf{paper profile}): encrypted payloads after \\texttt{friend-session-attached}; $n$ repeats per size (warmup discarded). Metric: sender \\texttt{file-published} to receiver first \\texttt{inbound-stored} block. Last column: 95\\% CI of the mean when $n{>}1$.`
      : `One-way convergence latency (${esc(topology)}) for friend carriage v0 after friend-session formation. Payloads are encrypted volume files; metric uses first \\texttt{inbound-stored} block when available.`;

const ciCol = hasCi ? '95\\% CI (mean)' : 'mean';
const resultsTable = `% Auto-generated — nearbytes-benchmarks/scripts/render-benchmark-figures.mjs
% Requires: \\usepackage{booktabs}
\\begin{table}[t]
\\centering
\\caption{${latencyCaption}}
\\label{tab:bench-latency}
\\small
\\setlength{\\tabcolsep}{3pt}
\\begin{tabular}{@{}lrrrr@{}}
\\toprule
Payload & $n$ & $p_{50}$ & $p_{95}$ & ${ciCol} \\\\
\\midrule
${latencyRows || '--- & 0 & --- & --- & --- \\\\'}
\\bottomrule
\\end{tabular}
\\end{table}
`;

function phaseRow(label, p) {
  if (!p) return `${esc(label)} & --- & --- & --- \\\\`;
  return `${esc(label)} & ${fmtMs(p.bootMs)} & ${fmtMs(p.friendSessionMs)} & ${fmtMs(p.totalWallMs)} \\\\`;
}

const alicePhases = report.phases?.alice;
const bobPhases = report.phases?.bob;
const senderPhases = report.phases?.sender ?? alicePhases;
const receiverPhases = report.phases?.receiver ?? bobPhases;

const phasesTable = `% Auto-generated phase breakdown (wall clock per process)
\\begin{table}[t]
\\centering
\\caption{Measured wall-clock phases (${esc(topology)}). \\emph{Boot} is config + skeleton + sync start; \\emph{Friend session} is until \\texttt{friend-session-attached} (handshake + mDNS/Hyperswarm); \\emph{Total} includes publish/receive/grace for the benchmark driver.}
\\label{tab:bench-phases}
\\small
\\setlength{\\tabcolsep}{5pt}
\\begin{tabular}{@{}lrrr@{}}
\\toprule
Node & Boot & Friend session & Total \\\\
\\midrule
${senderPhases ? phaseRow('Alice / sender', senderPhases) : ''}
${receiverPhases ? phaseRow('Bob / receiver', receiverPhases) : ''}
\\bottomrule
\\end{tabular}
\\end{table}
`;

const swarmAlice =
  report.swarmFormation?.sender?.p50 ??
  report.swarmFormation?.senderMs ??
  '---';
const swarmBob =
  report.swarmFormation?.receiver?.p50 ??
  report.swarmFormation?.receiverMs ??
  '---';
const goodputRows = (report.goodputTable ?? []).map((r) => ({
  ...r,
  goodputMbps: r.goodputMbps ?? r.mean,
}));
const decompRows = report.latencyDecompositionTable ?? [];
const primaryGp = goodputRows.find((r) => r.sizeBytes === 32 * 1024 * 1024) ?? goodputRows[0];
const goodput = report.throughput?.receiverGoodputMbps ?? primaryGp?.goodputMbps;

function axisOpts(table, xKey = 'sizeBytes') {
  return axisMiBOpts(table, xKey);
}

function latencyPlotBody(table, yKey) {
  if (hasErrorBars(table, yKey)) {
    const rows = table
      .filter((r) => r[yKey] != null && r.ci95Low != null && r.ci95High != null)
      .map((r) => {
        const x = miB(r.sizeBytes);
        const y = Number(r[yKey]).toFixed(2);
        const lo = Number(r.ci95Low).toFixed(2);
        const hi = Number(r.ci95High).toFixed(2);
        return `  \\draw[${COLORS.total}, line width=0.6pt] (axis cs:${x},${lo}) -- (axis cs:${x},${hi});`;
      })
      .join('\n');
    return `${rows}
\\addplot+[${COLORS.total}, thick, mark=*, mark size=2pt] coordinates {
${plotCoords(table, yKey)}
};`;
  }
  return `\\addplot+[${COLORS.total}, thick, mark=*, mark size=2pt] coordinates {\n${plotCoords(table, yKey)}\n};`;
}

const plotWithErrors = latencyPlotBody;

const goodputSweepRows = goodputRows
  .map(
    (r) =>
      `${esc(r.sizeLabel)} & ${r.n ?? 1} & ${fmtMbps(r.goodputMbps)} & ${fmtCi(r)} & ${fmtMs(r.inboundDurationMs)} \\\\`,
  )
  .join('\n');

const publishCpuSource = report.publishCpuTable ?? [];
const publishCpuRows = publishCpuSource
  .map(
    (r) =>
      `${esc(r.sizeLabel)} & ${r.n ?? 0} & ${fmtMs(r.p50)} & ${fmtCi(r)} \\\\`,
  )
  .join('\n');

const goodputTableTex = `% Auto-generated goodput sweep
\\begin{table}[t]
\\centering
\\caption{Sustained application goodput by stream size (${esc(topology)}). $n$ campaign seeds after quality filter; 95\\% CI via bootstrap across seeds. Goodput uses receiver \\texttt{inbound-stored} blocks between per-stream phase markers (encrypt + sync included).}
\\label{tab:bench-goodput}
\\small
\\setlength{\\tabcolsep}{4pt}
\\begin{tabular}{@{}lrrrr@{}}
\\toprule
Stream & $n$ & Goodput (Mb/s) & 95\\% CI & Span \\\\
\\midrule
${goodputSweepRows || '--- & 0 & --- & --- & --- \\\\'}
\\bottomrule
\\end{tabular}
\\end{table}
`;

const decompCryptoCoords = seriesCoords(decompRows, 'publishCpuP50');
const decompSyncCoords = seriesCoords(decompRows, 'syncTransferP50');
const latP50Coords = seriesCoords(latencySource, 'p50');
const latP95Coords = seriesCoords(latencySource, 'p95');
const gpCoords = seriesCoords(goodputRows, 'goodputMbps');
const gpCpuCoords = seriesCoords(goodputRows, 'publishCpuP50');
const decompAxis = axisOpts(decompRows);
const latAxis = axisOpts(latencySource);
const gpAxis = axisOpts(goodputRows);

const publishCpuTableTex = `% Auto-generated publish CPU (sender addFile path)
\\begin{table}[t]
\\centering
\\caption{Sender-side publish CPU time per payload size (${esc(topology)}): \\texttt{addFile} path (encrypt + journal + store). $n$ seeds after quality filter; bootstrap 95\\% CI across seeds.}
\\label{tab:bench-publish-cpu}
\\small
\\begin{tabular}{@{}lrrr@{}}
\\toprule
Payload & $n$ & $p_{50}$ & 95\\% CI (mean) \\\\
\\midrule
${publishCpuRows || '--- & 0 & --- & --- \\\\'}
\\bottomrule
\\end{tabular}
\\end{table}
`;

const latencyPlot = `% Auto-generated latency (total)
\\begin{figure}[t]
\\centering
\\begin{tikzpicture}
\\begin{axis}[nearbytes, width=0.92\\linewidth, height=5.5cm,
  xlabel={Payload size (MiB)}, ylabel={One-way latency (ms)}, ymin=0, ${latAxis}]
\\addplot+[${COLORS.total}, thick, mark=*] coordinates {${latP50Coords}};
\\addplot+[mark=square*, ${COLORS.p95}, dashed, thick] coordinates {${latP95Coords}};
\\legend{$p_{50}$ (total), $p_{95}$}
\\end{axis}
\\end{tikzpicture}
\\caption{End-to-end convergence latency vs payload (${esc(topology)}). Marker: $p_{50}$ with 95\\% CI of mean (Student-$t$); dashed: $p_{95}$.}
\\label{fig:bench-latency-plot}
\\end{figure}
`;

const latencyCryptoPlot =
  decompRows.length > 0
    ? `% Auto-generated latency crypto decomposition (stacked)
\\begin{figure}[t]
\\centering
\\begin{tikzpicture}
\\begin{axis}[nearbytes, width=0.92\\linewidth, height=5.5cm,
  xlabel={Payload size (MiB)}, ylabel={Latency (ms)}, ymin=0,
  ybar stacked, bar width=0.06,
  ${decompAxis},
  legend style={at={(0.02,0.98)},anchor=north west}]
\\addplot+[ybar, fill=${COLORS.crypto}!90, draw=${COLORS.crypto}!90] coordinates {
${decompCryptoCoords}
};
\\addplot+[ybar, fill=${COLORS.sync}!85, draw=${COLORS.sync}!85] coordinates {
${decompSyncCoords}
};
\\legend{Publish CPU (encrypt+store), Sync+receive (residual)}
\\end{axis}
\\end{tikzpicture}
\\caption{Latency decomposition (${esc(topology)}): $p_{50}$ of sender \\texttt{addFile} CPU (encrypt, journal, local store) vs residual until first receiver \\texttt{inbound-stored} block (sync + decrypt + delivery).}
\\label{fig:bench-latency-crypto}
\\end{figure}
`
    : '';

const goodputPlot =
  goodputRows.length > 0
    ? `% Auto-generated goodput
\\begin{figure}[t]
\\centering
\\begin{tikzpicture}
\\begin{axis}[nearbytes, width=0.92\\linewidth, height=5.5cm,
  xlabel={Stream size (MiB)}, ylabel={Application goodput (Mb/s)}, ymin=0, ${gpAxis}]
\\addplot+[${COLORS.goodput}, thick, mark=*] coordinates {${gpCoords}};
\\end{axis}
\\end{tikzpicture}
\\caption{Application goodput vs stream size (${esc(topology)}). Includes encryption, framing, and sync; bootstrap 95\\% CI across seeds.}
\\label{fig:bench-goodput-plot}
\\end{figure}
`
    : '';

const goodputCryptoPlot =
  goodputRows.length > 0
    ? `% Auto-generated goodput + publish CPU (dual axis)
\\begin{figure}[t]
\\centering
\\begin{tikzpicture}
\\begin{axis}[nearbytes, width=0.92\\linewidth, height=5.5cm, name plot=goodput,
  xlabel={Stream size (MiB)}, ylabel={Goodput (Mb/s)}, ymin=0, ${gpAxis}]
\\addplot+[${COLORS.goodput}, thick, mark=*] coordinates {${gpCoords}};
\\end{axis}
\\begin{axis}[nearbytes, width=0.92\\linewidth, height=5.5cm,
  at={(goodput.south west)}, anchor=south west,
  axis y line*=right, axis x line=none, ymin=0,
  ylabel={Stream publish CPU (ms)}, ylabel style={${COLORS.crypto}},
  yticklabel style={${COLORS.crypto}}]
\\addplot+[mark=triangle*, thick, ${COLORS.crypto}, dashed] coordinates {${gpCpuCoords}};
\\end{axis}
\\end{tikzpicture}
\\caption{Goodput vs stream size with sender publish CPU overlay (${esc(topology)}). Bars: sustained goodput; dashed line: $p_{50}$ CPU to encrypt and journal each stream before wire transfer.}
\\label{fig:bench-goodput-crypto}
\\end{figure}
`
    : '';

const performancePanel =
  decompRows.length > 0 && goodputRows.length > 0
    ? `% Auto-generated 2x2 performance panel (minipage grid — no groupplot)
\\begin{figure*}[t]
\\centering
\\begin{minipage}[t]{0.48\\textwidth}
\\centering
\\begin{tikzpicture}
\\begin{axis}[${panelAxis('a) Latency decomposition', 'MiB', 'ms', `ybar stacked, bar width=0.06, ${decompAxis}`)}]
\\addplot+[ybar, fill=${COLORS.crypto}!90] coordinates {${decompCryptoCoords}};
\\addplot+[ybar, fill=${COLORS.sync}!85] coordinates {${decompSyncCoords}};
\\end{axis}
\\end{tikzpicture}
\\end{minipage}\\hfill
\\begin{minipage}[t]{0.48\\textwidth}
\\centering
\\begin{tikzpicture}
\\begin{axis}[${panelAxis('b) Total latency', 'MiB', 'ms', latAxis)}]
\\addplot+[${COLORS.total}, thick, mark=*] coordinates {${latP50Coords}};
\\end{axis}
\\end{tikzpicture}
\\end{minipage}
\\par\\medskip
\\begin{minipage}[t]{0.48\\textwidth}
\\centering
\\begin{tikzpicture}
\\begin{axis}[${panelAxis('c) Goodput', 'MiB', 'Mb/s', gpAxis)}]
\\addplot+[${COLORS.goodput}, thick, mark=*] coordinates {${gpCoords}};
\\end{axis}
\\end{tikzpicture}
\\end{minipage}\\hfill
\\begin{minipage}[t]{0.48\\textwidth}
\\centering
\\begin{tikzpicture}
\\begin{axis}[${panelAxis('d) Stream publish CPU', 'MiB', 'ms', gpAxis)}]
\\addplot+[mark=triangle*, thick, ${COLORS.crypto}] coordinates {${gpCpuCoords}};
\\end{axis}
\\end{tikzpicture}
\\end{minipage}
\\caption{Performance overview (${esc(topology)}${report.campaignSeeds != null ? `, ${report.campaignSeeds} seeds` : ''}). (a) Latency split into local publish path vs network+peer delivery. (b--d) End-to-end latency, application goodput, and stream publish CPU.}
\\label{fig:bench-performance-panel}
\\end{figure*}
`
    : '';

const publishCpuPlot =
  publishCpuSource.length > 0
    ? `% Auto-generated publish CPU
\\begin{figure}[t]
\\centering
\\begin{tikzpicture}
\\begin{axis}[nearbytes, width=0.92\\linewidth, height=5.2cm,
  xlabel={Payload size (MiB)}, ylabel={Publish CPU (ms)}, xmin=0, ymin=0]
${plotWithErrors(publishCpuSource, 'mean')}
\\end{axis}
\\end{tikzpicture}
\\caption{Sender publish CPU vs payload (${esc(topology)}): \\texttt{addFile} path (encrypt + journal + store).}
\\label{fig:bench-publish-cpu-plot}
\\end{figure}
`
    : '';

const mscFigure = `% Auto-generated MSC-style collaboration diagram
\\begin{figure}[t]
\\centering
\\begin{tikzpicture}[font=\\small, node distance=0.55cm and 3.0cm]
  \\node[draw, rounded corners, minimum width=2.4cm] (alice) {Alice};
  \\node[draw, rounded corners, minimum width=2.4cm, right=of alice] (bob) {Bob};
  \\node[draw, rounded corners, minimum width=2.0cm, below=0.85cm of alice] (lan) {mDNS + DHT};
  \\draw[dashed,->] (alice) -- node[above,sloped,font=\\footnotesize]{\\texttt{topic(profile)}} (lan);
  \\draw[dashed,->] (bob) -- node[above,sloped,font=\\footnotesize]{\\texttt{topic(profile)}} (lan);
  \\draw[->] (lan) -- node[left,font=\\footnotesize]{duplex} (alice);
  \\draw[->] (lan) -- node[right,font=\\footnotesize]{duplex} (bob);
  \\node[below=0.12cm of alice,font=\\footnotesize] {$+${swarmAlice}\\,ms$};
  \\node[below=0.12cm of bob,font=\\footnotesize] {$+${swarmBob}\\,ms$};
\\end{tikzpicture}
\\caption{Collaboration timeline (${esc(topology)}). Both nodes publish profile records, complete \\texttt{hello}, then reactive \\texttt{have}/\\texttt{want} on \\texttt{nearbytes.sync.v1} (no timer-driven delta polling).}
\\label{fig:bench-msc}
\\end{figure}
`;

/** Paths from paper.tex (pdflatex cwd = paper repo root). */
const FIG = 'figures';
const masterTable = `% Auto-generated figure inputs (included from paper.tex via \\input{${FIG}/benchmark-tables.tex})
\\input{${FIG}/benchmark-phases-table.tex}
\\input{${FIG}/benchmark-latency-table.tex}
\\input{${FIG}/benchmark-goodput-table.tex}
\\input{${FIG}/benchmark-publish-cpu-table.tex}
\\input{${FIG}/benchmark-performance-panel.tex}
`;

await writeFile(path.join(outDir, 'benchmark-figures-preamble.tex'), PGF_PREAMBLE);
await writeFile(path.join(outDir, 'benchmark-latency-table.tex'), resultsTable);
await writeFile(path.join(outDir, 'benchmark-phases-table.tex'), phasesTable);
await writeFile(path.join(outDir, 'benchmark-goodput-table.tex'), goodputTableTex);
await writeFile(path.join(outDir, 'benchmark-publish-cpu-table.tex'), publishCpuTableTex);
await writeFile(path.join(outDir, 'benchmark-latency-plot.tex'), latencyPlot);
await writeFile(path.join(outDir, 'benchmark-latency-crypto-plot.tex'), latencyCryptoPlot);
await writeFile(path.join(outDir, 'benchmark-goodput-plot.tex'), goodputPlot);
await writeFile(path.join(outDir, 'benchmark-goodput-crypto-plot.tex'), goodputCryptoPlot);
await writeFile(path.join(outDir, 'benchmark-publish-cpu-plot.tex'), publishCpuPlot);
await writeFile(path.join(outDir, 'benchmark-performance-panel.tex'), performancePanel);
await writeFile(path.join(outDir, 'benchmark-msc.tex'), mscFigure);
await writeFile(path.join(outDir, 'benchmark-tables.tex'), masterTable);

const seedsNote =
  report.campaignSeeds != null ? ` (${report.campaignSeeds} seeds)` : '';
const summaryTex = `% Auto-generated benchmark summary (${esc(report.generatedAt?.slice(0, 10) ?? '')})
\\paragraph{Harness results (${esc(topology)})${seedsNote}.}
Friend session $p_{50}$: $+${swarmAlice}$ (Alice), $+${swarmBob}$ (Bob). Primary stream goodput ${fmtMbps(goodput)}\\,Mb/s. Tables~\\ref{tab:bench-latency}--\\ref{tab:bench-goodput} report latency, goodput, and publish CPU.
`;
await writeFile(path.join(outDir, 'benchmark-summary.tex'), summaryTex);

console.log(`Wrote LaTeX to ${outDir}`);
console.log('  benchmark-figures-preamble.tex, benchmark-performance-panel.tex');
console.log('  benchmark-latency-crypto-plot.tex, benchmark-goodput-crypto-plot.tex');
