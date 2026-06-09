/**
 * Sustained transfer sessions — accumulate ≥minWallMs of measured wall time per
 * rep (default 20 s) on a warm path so micro startup does not dominate goodput.
 *
 * Reports both end-to-end goodput (bytes / Σ wallMs) and wire-window goodput
 * (bytes / first-wire→last-wire) when phase timelines are available.
 */
export const DEFAULT_SUSTAINED_MIN_WALL_MS = 20_000;

/**
 * @param {number|string|undefined} ms
 * @returns {number}
 */
export function sustainedMinWallMs(ms) {
  const n = Number(ms ?? process.env.NEARBYTES_SUSTAINED_MIN_WALL_MS ?? DEFAULT_SUSTAINED_MIN_WALL_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SUSTAINED_MIN_WALL_MS;
  return Math.round(n);
}

export function mbps(bytes, ms) {
  return ms > 0 ? Number(((bytes * 8) / ms / 1000).toFixed(2)) : 0;
}

/**
 * @param {{ publishStartedAt?: number, timeline?: { epochMs?: number, segments?: { id: string, startMs: number, endMs: number }[] } }}[]} transfers
 */
export function wireWindowFromTransfers(transfers) {
  let firstWireAbs = Infinity;
  let lastWireAbs = -Infinity;
  let sumWireSegmentMs = 0;
  for (const t of transfers) {
    const epoch = t.publishStartedAt ?? t.timeline?.epochMs;
    const wireSeg = t.timeline?.segments?.find((s) => s.id === 'wire');
    if (!wireSeg || epoch == null) continue;
    const ws = epoch + wireSeg.startMs;
    const we = epoch + wireSeg.endMs;
    firstWireAbs = Math.min(firstWireAbs, ws);
    lastWireAbs = Math.max(lastWireAbs, we);
    sumWireSegmentMs += Math.max(0, wireSeg.endMs - wireSeg.startMs);
  }
  const wireWindowMs =
    Number.isFinite(firstWireAbs) && lastWireAbs > firstWireAbs ? lastWireAbs - firstWireAbs : 0;
  return { wireWindowMs, sumWireSegmentMs };
}

/**
 * @param {object[]} transfers
 * @param {number} minWallMs
 */
export function summarizeSustainedSession(transfers, minWallMs) {
  const wallMs = transfers.reduce((s, t) => s + (t.wallMs ?? 0), 0);
  const bytes = transfers.reduce((s, t) => s + (t.bytes ?? 0), 0);
  const { wireWindowMs, sumWireSegmentMs } = wireWindowFromTransfers(transfers);
  return {
    wallMs,
    bytes,
    transferCount: transfers.length,
    goodputMbps: mbps(bytes, wallMs),
    goodputWireMbps: wireWindowMs > 0 ? mbps(bytes, wireWindowMs) : null,
    wireWindowMs,
    sumWireSegmentMs,
    minWallMs,
    sustainedTargetReached: wallMs >= minWallMs,
    wireTargetReached: wireWindowMs >= minWallMs,
  };
}
