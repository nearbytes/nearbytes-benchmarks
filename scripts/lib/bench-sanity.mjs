/**
 * Physics and completeness checks for benchmark JSON before paper figures.
 * Used by nearbytes-benchmarks runners and paper-nearbytes-hypercore validation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Transfer-matrix cases used as the sole Nearbytes source for network figures. */
export const TM_NETWORK_NEARBYTES = {
  local: { large: '128MiB_x1_seq', burst: '64MiB_4MiB_x16_burst' },
  lan: { large: '128MiB_x1_seq', burst: '64MiB_512KiB_x128_burst' },
  wan: { large: '128MiB_x1_seq', burst: '64MiB_1MiB_x64_burst' },
};

const REQUIRED_TM = ['local', 'lan', 'wan'];

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readTransferMatrix(dataRoot, cat) {
  const primary = join(dataRoot, 'protocol', `transfer-matrix-${cat}.json`);
  const full = join(dataRoot, 'protocol', `transfer-matrix-${cat}-full.json`);
  return readJson(primary) ?? readJson(full);
}

function tmCategoryKey(tm) {
  return tm.categories?.[0] ?? null;
}

function tmRows(tm, cat) {
  const key = cat ?? tmCategoryKey(tm);
  return tm?.results?.[key] ?? [];
}

function findTmNearbytes(tm, label) {
  const row = tmRows(tm).find((r) => r.plan?.label === label);
  const nb = row?.systems?.nearbytes;
  if (!nb || !Number.isFinite(nb.goodputMbps)) return null;
  return { goodputMbps: nb.goodputMbps, wallMs: nb.wallMs, label, row };
}

/** Wire ceiling (Mb/s) from per-row nc baseline or category fallback. */
function wireCeilingMbps(tm, cat) {
  let maxNc = 0;
  for (const row of tmRows(tm, cat)) {
    const nc = row.systems?.nc?.goodputMbps;
    if (Number.isFinite(nc)) maxNc = Math.max(maxNc, nc);
  }
  if (maxNc > 0) return maxNc * 1.05;
  const fallback = { local: 50_000, lan: 98, wan: 60 };
  return fallback[cat] ?? 120;
}

function checkTransferMatrix(dataRoot, errors) {
  for (const cat of REQUIRED_TM) {
    const tm = readTransferMatrix(dataRoot, cat);
    if (!tm) {
      errors.push(`missing transfer-matrix-${cat}.json (or -full.json) under ${join(dataRoot, 'protocol')}`);
      continue;
    }
    if (tm.status && tm.status !== 'complete') {
      errors.push(`transfer-matrix-${cat}.json status=${tm.status} (need complete)`);
    }
    const ceiling = wireCeilingMbps(tm, cat);
    for (const [sz, label] of Object.entries(TM_NETWORK_NEARBYTES[cat] ?? {})) {
      const nb = findTmNearbytes(tm, label);
      if (!nb) {
        errors.push(`transfer-matrix-${cat}: missing nearbytes row ${label} (${sz})`);
        continue;
      }
      if (nb.goodputMbps > ceiling) {
        errors.push(
          `transfer-matrix-${cat} ${label}: nearbytes ${nb.goodputMbps.toFixed(1)} Mb/s exceeds wire ceiling ${ceiling.toFixed(1)} Mb/s`,
        );
      }
    }
  }
}

function readNetworkReport(dataRoot, cat) {
  return (
    readJson(join(dataRoot, 'network', `${cat}-results.json`)) ??
    readJson(join(dataRoot, 'network', `${cat}.json`))
  );
}

function checkNetworkSmallLatency(dataRoot, errors) {
  for (const cat of ['local', 'lan', 'wan']) {
    const net = readNetworkReport(dataRoot, cat);
    if (!net) {
      errors.push(`missing network/${cat}.json (small-payload latency figure)`);
      continue;
    }
    const sc = net.sizeClasses?.find((x) => x.sizeClass === 'small');
    if (!sc?.systems || Object.keys(sc.systems).length < 2) {
      errors.push(`network/${cat}.json: missing small sizeClass systems`);
      continue;
    }
    const nb = sc.systems.nearbytes?.wallMs?.p50;
    if (!Number.isFinite(nb)) {
      errors.push(`network/${cat}.json: missing nearbytes small wallMs`);
    }
  }
}

function checkOptAblation(dataRoot, errors) {
  const path = join(dataRoot, 'protocol', 'opt-ablation-local.json');
  if (!existsSync(path)) {
    errors.push(`missing ${path}`);
    return;
  }
  const ab = readJson(path);
  if (!ab?.results?.length) {
    errors.push('opt-ablation-local.json has no results');
  }
}

/**
 * @param {string} dataRoot  directory containing protocol/ and network/ subdirs
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateBenchData(dataRoot) {
  const errors = [];
  checkTransferMatrix(dataRoot, errors);
  checkNetworkSmallLatency(dataRoot, errors);
  checkOptAblation(dataRoot, errors);
  return { ok: errors.length === 0, errors };
}
