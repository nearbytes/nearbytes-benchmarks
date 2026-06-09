/**
 * End-to-end phase timeline from publish wall-clock + bulk-recv-phases markers.
 * Epoch = alice publishStartedAt (ms). Segments may overlap (publish ∥ wire).
 *
 * Markers are emitted on the normal receive path; this module only derives
 * intervals from timestamps already recorded during the transfer.
 */

const SEGMENT_ORDER = ['publish', 'wait', 'wire', 'drain', 'hash', 'rename'];

const SEGMENT_META = {
  publish: { role: 'alice', label: 'publish (encrypt+journal)' },
  wait: { role: 'sync', label: 'wait first byte' },
  wire: { role: 'bob', label: 'wire (first→last byte)' },
  drain: { role: 'bob', label: 'disk drain' },
  hash: { role: 'bob', label: 'hash verify' },
  rename: { role: 'bob', label: 'rename + log' },
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rel(epoch, abs) {
  if (abs == null || epoch == null) return null;
  return abs - epoch;
}

/** @param {{ publishStartedAt: number, publishWallMs: number, recvPhases: object[] }} input */
export function buildPhaseTimeline({ publishStartedAt, publishWallMs, recvPhases }) {
  const epoch = publishStartedAt;
  const segments = [];
  const pubEnd = publishWallMs ?? 0;
  segments.push({
    id: 'publish',
    ...SEGMENT_META.publish,
    startMs: 0,
    endMs: pubEnd,
  });

  const phases = mergeRecvPhases(recvPhases);
  if (phases) {
    const fb = rel(epoch, phases.firstByteAt);
    const lb = rel(epoch, phases.lastByteAt ?? phases.firstByteAt);
    const drain = rel(epoch, phases.diskDrainDoneAt ?? phases.lastByteAt);
    const hash = rel(epoch, phases.hashDoneAt ?? phases.diskDrainDoneAt);
    const rename = rel(epoch, phases.renameDoneAt ?? phases.hashDoneAt);

    if (fb != null && fb > pubEnd + 0.5) {
      segments.push({ id: 'wait', ...SEGMENT_META.wait, startMs: pubEnd, endMs: fb });
    }
    if (fb != null && lb != null && lb > fb) {
      segments.push({ id: 'wire', ...SEGMENT_META.wire, startMs: fb, endMs: lb });
    }
    if (lb != null && drain != null && drain > lb) {
      segments.push({ id: 'drain', ...SEGMENT_META.drain, startMs: lb, endMs: drain });
    }
    if (drain != null && hash != null && hash > drain) {
      segments.push({ id: 'hash', ...SEGMENT_META.hash, startMs: drain, endMs: hash });
    }
    if (hash != null && rename != null && rename > hash) {
      segments.push({ id: 'rename', ...SEGMENT_META.rename, startMs: hash, endMs: rename });
    }
  }

  const e2eMs = segments.reduce((m, s) => Math.max(m, s.endMs), 0);
  return {
    epochMs: epoch,
    publishWallMs: pubEnd,
    segments,
    e2eMs,
    segmentOrder: SEGMENT_ORDER,
  };
}

function mergeRecvPhases(list) {
  if (!list?.length) return null;
  const valid = list.filter((p) => p && num(p.firstByteAt) != null);
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];
  return {
    firstByteAt: Math.min(...valid.map((p) => num(p.firstByteAt))),
    lastByteAt: Math.max(...valid.map((p) => num(p.lastByteAt ?? p.firstByteAt))),
    diskDrainDoneAt: Math.max(...valid.map((p) => num(p.diskDrainDoneAt ?? p.lastByteAt ?? p.firstByteAt))),
    hashDoneAt: Math.max(...valid.map((p) => num(p.hashDoneAt ?? p.diskDrainDoneAt ?? p.lastByteAt))),
    renameDoneAt: Math.max(...valid.map((p) => num(p.renameDoneAt ?? p.hashDoneAt))),
  };
}

/** Aggregate segment start/end across repeats (p50 bar, min–max whisker). */
export function aggregateTimelines(timelines) {
  const byId = new Map();
  for (const id of SEGMENT_ORDER) {
    byId.set(id, { startMs: [], endMs: [] });
  }
  for (const tl of timelines) {
    for (const seg of tl.segments ?? []) {
      const bucket = byId.get(seg.id);
      if (!bucket) continue;
      bucket.startMs.push(seg.startMs);
      bucket.endMs.push(seg.endMs);
    }
  }
  const segments = [];
  for (const id of SEGMENT_ORDER) {
    const { startMs, endMs } = byId.get(id);
    if (!startMs.length) continue;
    const st = quantile(startMs, 0.5);
    const en = quantile(endMs, 0.5);
    segments.push({
      id,
      ...SEGMENT_META[id],
      startMs: st,
      endMs: en,
      startMinMs: Math.min(...startMs),
      startMaxMs: Math.max(...startMs),
      endMinMs: Math.min(...endMs),
      endMaxMs: Math.max(...endMs),
      n: startMs.length,
    });
  }
  const e2e = timelines.map((t) => t.e2eMs).filter(Number.isFinite);
  return {
    segments,
    e2eMs: e2e.length ? quantile(e2e, 0.5) : null,
    e2eMinMs: e2e.length ? Math.min(...e2e) : null,
    e2eMaxMs: e2e.length ? Math.max(...e2e) : null,
    n: timelines.length,
  };
}

function quantile(sorted, p) {
  const arr = [...sorted].sort((a, b) => a - b);
  if (!arr.length) return null;
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

export { SEGMENT_ORDER, SEGMENT_META };
