import type { Log } from 'nearbytes-log';

export interface BenchMarker {
  readonly event: string;
  readonly t: number;
  readonly fields: Record<string, string | number | boolean>;
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

export async function readBenchMarkers(log: Log): Promise<BenchMarker[]> {
  const lines = await log.sync.readMarkers();
  const out: BenchMarker[] = [];
  for (const line of lines) {
    if (!line.startsWith('bench ')) continue;
    try {
      const parsed = JSON.parse(line.slice(6)) as {
        bench: string;
        t: number;
        [key: string]: string | number | boolean;
      };
      const { bench: event, t, ...rest } = parsed;
      out.push({ event, t, fields: rest });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
