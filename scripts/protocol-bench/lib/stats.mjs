export function quantiles(xs) {
  const v = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
  return {
    n: v.length,
    min: v[0],
    p50: q(50),
    p95: q(95),
    max: v[v.length - 1],
    mean: v.reduce((a, b) => a + b, 0) / v.length,
  };
}

export function studentCi95(values, { min = -Infinity } = {}) {
  const v = values.filter(Number.isFinite);
  const n = v.length;
  if (n < 2) return null;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const variance = v.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const t = n <= 30 ? tTable(n - 1) : 1.96;
  const half = t * se;
  return { n, mean, low: Math.max(min, mean - half), high: mean + half };
}

function tTable(df) {
  const table = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262,
    10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145, 15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101,
    19: 2.093, 20: 2.086, 21: 2.08, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052,
    28: 2.048, 29: 2.045, 30: 2.042,
  };
  return table[df] ?? 2.0;
}
