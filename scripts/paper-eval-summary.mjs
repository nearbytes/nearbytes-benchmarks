#!/usr/bin/env node
/** Print claim→result summary from .local/bench JSON (for paper refresh reports). */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = join(REPO, '.local', 'bench');

const TM_CASES = {
  local: { large: '128MiB_x1_seq', burst: '64MiB_4MiB_x16_burst' },
  lan: { large: '128MiB_x1_seq', burst: '64MiB_512KiB_x128_burst' },
  wan: { large: '128MiB_x1_seq', burst: '64MiB_1MiB_x64_burst' },
};

const BURST_CASE = '64MiB_4MiB_x16_burst';

function j(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function netReport(cat) {
  return j(join(BENCH, 'network', `${cat}-results.json`)) ?? j(join(BENCH, 'network', `${cat}.json`));
}

function tmRow(tm, label) {
  const k = tm.categories?.[0];
  return tm.results?.[k]?.find((r) => r.plan?.label === label);
}

function pct(nb, base) {
  if (!Number.isFinite(nb) || !Number.isFinite(base) || base <= 0) return '—';
  return `${((nb / base) * 100).toFixed(0)}%`;
}

function main() {
  console.log('\n=== Paper evaluation summary ===\n');

  for (const cat of ['local', 'lan', 'wan']) {
    const net = netReport(cat);
    const sc = net?.sizeClasses?.find((x) => x.sizeClass === 'small');
    if (!sc) continue;
    console.log(`C2 small latency (${cat}, 64 KiB, p50 wall ms):`);
    for (const sys of Object.keys(sc.systems ?? {})) {
      const w = sc.systems[sys]?.wallMs?.p50;
      if (Number.isFinite(w)) console.log(`  ${sys}: ${w.toFixed(1)} ms`);
    }
    console.log('');
  }

  for (const cat of ['local', 'lan', 'wan']) {
    const tm = j(join(BENCH, 'protocol', `transfer-matrix-${cat}-full.json`))
      ?? j(join(BENCH, 'protocol', `transfer-matrix-${cat}.json`));
    if (!tm) continue;
    console.log(`C3 throughput (${cat}, transfer-matrix, Mb/s goodput):`);
    for (const [sz, label] of Object.entries(TM_CASES[cat])) {
      const row = tmRow(tm, label);
      if (!row) continue;
      const nb = row.systems?.nearbytes?.goodputMbps;
      const bases = cat === 'local' ? ['nc', 'cat'] : ['rsync', 'scp'];
      const best = Math.max(...bases.map((s) => row.systems?.[s]?.goodputMbps ?? 0));
      const bestName = bases.find((s) => row.systems?.[s]?.goodputMbps === best) ?? bases[0];
      console.log(
        `  ${sz} (${label}): nearbytes=${Number.isFinite(nb) ? nb.toFixed(1) : '—'} vs best ${bestName}=${best.toFixed(1)} (${pct(nb, best)} of baseline)`,
      );
    }
    console.log('');
  }

  const ab = j(join(BENCH, 'protocol', 'opt-ablation-local.json'));
  const burstKey = BURST_CASE;
  if (ab?.results?.length) {
    console.log('C6 opt-ablation (loopback 16×4 MiB burst, % vs all-on):');
    const allOn = ab.results.find((r) => (r.disabled ?? r.flagsOff ?? []).length === 0);
    const baseGp = allOn?.cases?.[burstKey]?.goodputMbps;
    for (const r of ab.results) {
      const off = r.disabled ?? r.flagsOff ?? [];
      if (off.length !== 1) continue;
      const gp = r.cases?.[burstKey]?.goodputMbps;
      const d = r.cases?.[burstKey]?.deltaPct ?? (
        Number.isFinite(baseGp) && Number.isFinite(gp)
          ? ((gp - baseGp) / baseGp) * 100
          : null
      );
      console.log(
        `  off ${off[0]}: ${Number.isFinite(gp) ? gp.toFixed(1) : '—'} Mb/s (${Number.isFinite(d) ? d.toFixed(1) : '—'}%)`,
      );
    }
    console.log('');
  }
}

main();
