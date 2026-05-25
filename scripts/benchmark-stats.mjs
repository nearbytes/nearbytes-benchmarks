/**
 * Shared statistics for benchmark merge + LaTeX render.
 */

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Student-t multiplier for 95% two-sided CI (small n). */
const T95 = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  15: 2.131,
  20: 2.086,
  30: 2.042,
};

function tMultiplier(n) {
  if (n <= 0) return 1.96;
  if (n >= 30) return 2.042;
  return T95[n] ?? 2.0;
}

export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const sum = v.reduce((a, b) => a + b, 0);
  const mean = sum / v.length;
  const variance =
    v.length > 1
      ? v.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (v.length - 1)
      : 0;
  const stddev = Math.sqrt(variance);
  const margin = tMultiplier(v.length) * (stddev / Math.sqrt(v.length));
  return {
    n: v.length,
    min: v[0],
    p50: percentile(v, 50),
    p95: percentile(v, 95),
    max: v[v.length - 1],
    mean,
    stddev,
    ci95Low: mean - margin,
    ci95High: mean + margin,
  };
}

export function sizeLabel(sizeBytes) {
  if (sizeBytes >= 1024 * 1024) return `${sizeBytes / (1024 * 1024)} MiB`;
  return `${sizeBytes / 1024} KiB`;
}

export function parseBenchActivityLines(activityLog) {
  const events = [];
  for (const line of activityLog ?? []) {
    if (!line.startsWith('bench ')) continue;
    try {
      events.push(JSON.parse(line.slice(6)));
    } catch (err) {
      console.warn('[benchmark-stats] malformed activity line:', line.slice(0, 80), err);
    }
  }
  return events.sort((a, b) => a.t - b.t);
}

/** Goodput for one stream leg (match throughput-phase-start/end by streamIndex). */
export function goodputFromInboundMarkers(
  receiverLog,
  payloadBytes,
  senderLog = [],
  sinceWallMs,
  streamIndex,
) {
  const phaseEvents = parseBenchActivityLines(senderLog.length ? senderLog : receiverLog);
  const starts = phaseEvents.filter((e) => e.bench === 'throughput-phase-start');
  const ends = phaseEvents.filter((e) => e.bench === 'throughput-phase-end');
  const start =
    streamIndex !== undefined && streamIndex !== null
      ? starts.find((e) => e.streamIndex === streamIndex)
      : starts[starts.length - 1];
  const end =
    streamIndex !== undefined && streamIndex !== null
      ? ends.find((e) => e.streamIndex === streamIndex)
      : ends[ends.length - 1];
  const t0 = start?.t ?? sinceWallMs;
  if (t0 === undefined) return null;
  const tEnd = end?.t;
  const minBlockBytes = 4096;

  const events = parseBenchActivityLines(receiverLog);
  const blocks = events.filter(
    (e) =>
      e.bench === 'inbound-stored' &&
      e.kind === 'block' &&
      e.t >= t0 &&
      (tEnd === undefined || e.t <= tEnd + 500) &&
      Number(e.bytes) >= minBlockBytes,
  );
  if (blocks.length === 0) return null;

  const first = blocks[0].t;
  const last = blocks[blocks.length - 1].t;
  const durationMs =
    blocks.length === 1 ? Math.max(1, last - t0) : Math.max(1, last - first);

  const bytesReceived = blocks.reduce((s, b) => s + (Number(b.bytes) || 0), 0);
  const effectiveBytes =
    payloadBytes > 0 ? Math.min(payloadBytes, bytesReceived) : bytesReceived;
  const goodputMbps = (effectiveBytes * 8) / (durationMs * 1000);
  return {
    goodputMbps,
    durationMs,
    bytesReceived,
    nominalBytes: payloadBytes > 0 ? payloadBytes : bytesReceived,
    firstInboundMs: first,
    lastInboundMs: last,
    blockCount: blocks.length,
  };
}

export function isWarmupTrialName(name) {
  return typeof name === 'string' && name.includes('-warm-');
}

export function statsTableFromValues(byKey) {
  return [...byKey.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, values]) => ({
      sizeBytes: key,
      sizeLabel: sizeLabel(key),
      ...stats(values),
    }))
    .filter((r) => r.n > 0);
}

/** Bootstrap percentile CI across independent runs (seed-level). */
export function bootstrapCi95(values, iterations = 2000) {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0);
  if (v.length === 0) return null;
  if (v.length === 1) return { ...stats(v), ciMethod: 'single-sample' };
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < v.length; j++) {
      sum += v[Math.floor(Math.random() * v.length)];
    }
    means.push(sum / v.length);
  }
  means.sort((a, b) => a - b);
  const base = stats(v);
  return {
    ...base,
    ci95Low: percentile(means, 2.5),
    ci95High: percentile(means, 97.5),
    ciMethod: 'bootstrap-percentile-2.5-97.5',
  };
}
