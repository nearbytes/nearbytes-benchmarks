/**
 * Shared pgfplots builders for paper benchmark figures.
 */

export const COLORS = {
  total: 'NearBytesBlue',
  crypto: 'NearBytesOrange',
  sync: 'NearBytesTeal',
  goodput: 'NearBytesBlue',
  p95: 'NearBytesRed',
};

export const PGF_PREAMBLE = `% Auto-generated pgfplots style (include once in paper preamble)
\\definecolor{NearBytesBlue}{RGB}{33,102,172}
\\definecolor{NearBytesOrange}{RGB}{230,126,34}
\\definecolor{NearBytesTeal}{RGB}{26,152,80}
\\definecolor{NearBytesRed}{RGB}{192,57,43}
\\definecolor{NearBytesGray}{RGB}{120,120,120}
\\pgfplotsset{
  nearbytes/.style={
    compat=1.18,
    grid=both,
    grid style={line width=0.2pt, gray!25},
    major grid style={line width=0.4pt, gray!35},
    tick label style={font=\\footnotesize},
    label style={font=\\small},
    legend style={font=\\footnotesize, fill=white, fill opacity=0.92, draw=gray!40},
    every axis plot/.append style={line width=0.9pt},
  },
}
`;

export function miB(sizeBytes) {
  return (sizeBytes / (1024 * 1024)).toFixed(3);
}

const SIZE_TICK = {
  4096: 'fourK',
  65536: 'sixtyFourK',
  262144: 'twoFiftySixK',
  1048576: 'oneMiB',
  4194304: 'fourMiB',
  33554432: 'thirtyTwoMiB',
  134217728: 'oneTwentyEightMiB',
};

/** pgfplots-safe symbolic tick labels (no leading digits). */
export function sizeTickLabel(sizeBytes) {
  return SIZE_TICK[sizeBytes] ?? `sz${sizeBytes}`;
}

export function plotCoords(table, yKey, xKey = 'sizeBytes') {
  return table
    .filter((r) => r[yKey] != null && r[xKey] != null)
    .map((r) => `  ({${miB(r[xKey])}}, {${Number(r[yKey]).toFixed(2)}})`)
    .join('\n');
}

/** pgfplots error bar table: x, y, yerrplus, yerrminus */
export function errorBarTable(table, yKey, xKey = 'sizeBytes') {
  return table
    .filter((r) => r[yKey] != null && r[xKey] != null)
    .map((r) => {
      const x = miB(r[xKey]);
      const y = Number(r[yKey]).toFixed(2);
      const lo = r.ci95Low != null ? Math.max(0, r.ci95Low) : Number(r[yKey]);
      const hi = r.ci95High != null ? r.ci95High : Number(r[yKey]);
      const errLo = (Number(y) - lo).toFixed(2);
      const errHi = (hi - Number(y)).toFixed(2);
      return `  ${x} ${y} ${errHi} ${errLo}`;
    })
    .join('\n');
}

export function hasErrorBars(table, yKey = 'p50') {
  const withCi = table.filter((r) => {
    if (r[yKey] == null || r.ci95Low == null || r.ci95High == null) return false;
    const y = Number(r[yKey]);
    const lo = Number(r.ci95Low);
    const hi = Number(r.ci95High);
    if (!Number.isFinite(y) || !Number.isFinite(lo) || !Number.isFinite(hi)) return false;
    if ((r.n ?? 1) < 2) return false;
    return hi - lo > 0.01 && (y - lo > 0.01 || hi - y > 0.01);
  });
  return withCi.length >= 2;
}
