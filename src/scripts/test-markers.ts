import type { Log } from 'nearbytes-log';

export interface BenchMarker {
  readonly event: string;
  readonly t: number;
  readonly fields: Record<string, string | number | boolean>;
}

export interface BenchMarkerIndexed extends BenchMarker {
  readonly index: number;
}

export interface RunPhaseTiming {
  readonly bootMs: number;
  readonly profilePublishMs: number;
  readonly discoveryWaitMs: number;
  readonly friendSessionMs: number | null;
  readonly publishMs: number | null;
  readonly receiveMs: number | null;
  readonly graceMs: number;
  readonly totalWallMs: number;
}

export interface MarkerTail {
  offset: number;
  nextIndex: number;
}

export interface MarkerTailSnapshot {
  tail: MarkerTail;
}

function parseBenchLine(line: string): BenchMarker | null {
  if (!line.startsWith('bench ')) return null;
  try {
    const parsed = JSON.parse(line.slice(6)) as {
      bench: string;
      t: number;
      [key: string]: string | number | boolean;
    };
    const { bench: event, t, ...rest } = parsed;
    return { event, t, fields: rest };
  } catch {
    return null;
  }
}

export async function readBenchMarkers(log: Log): Promise<BenchMarker[]> {
  const lines = await log.sync.readMarkers();
  const out: BenchMarker[] = [];
  for (const line of lines) {
    const m = parseBenchLine(line);
    if (m) out.push(m);
  }
  return out;
}

/** Single-read watermark at end-of-log; only markers appended after this are polled. */
export async function createMarkerTail(log: Log): Promise<MarkerTailSnapshot> {
  const { lines, size } = await log.sync.readMarkersFrom(0);
  let nextIndex = 0;
  for (const line of lines) {
    if (parseBenchLine(line)) nextIndex++;
  }
  return { tail: { offset: size, nextIndex } };
}

export async function pollBenchMarkers(log: Log, tail: MarkerTail): Promise<BenchMarkerIndexed[]> {
  const { lines, size } = await log.sync.readMarkersFrom(tail.offset);
  tail.offset = size;
  const out: BenchMarkerIndexed[] = [];
  for (const line of lines) {
    const m = parseBenchLine(line);
    if (!m) continue;
    out.push({ ...m, index: tail.nextIndex++ });
  }
  return out;
}
