/** Protocol-bench workload grids (override with NEARBYTES_PROTOCOL_SMOKE=1). */

export const MIB = 1024 * 1024;

/** Maximum payload per file in a burst (MiB). Scale load via file count, not chunk size. */
export const FILE_CHUNK_MIB = 16;

export const CHAT_BODY_LEN = 256;

export const FULL = {
  chatTargets: [1, 10, 50, 100, 250, 500],
  chatWarmup: 1,
  /** Each entry: K files of FILE_CHUNK_MIB → aggregate K×16 MiB (up to 256 MiB). */
  fileBursts: [
    { count: 1, mode: 'seq' },
    { count: 4, mode: 'burst' },
    { count: 8, mode: 'burst' },
    { count: 16, mode: 'burst' },
  ],
  fileWarmup: 1,
  fileMeasured: 3,
  replayMidChat: [100, 500],
};

export const SMOKE = {
  chatTargets: [1, 10, 50],
  chatWarmup: 0,
  fileBursts: [{ count: 1, mode: 'seq' }, { count: 4, mode: 'burst' }],
  fileWarmup: 0,
  fileMeasured: 1,
  replayMidChat: [],
};

export function workload() {
  return process.env.NEARBYTES_PROTOCOL_SMOKE === '1' ? SMOKE : FULL;
}

export function chunkBytes() {
  return FILE_CHUNK_MIB * MIB;
}

export function aggregateBytes(count) {
  return chunkBytes() * count;
}

/** Wall-clock cap for one file burst (ms), scaled by aggregate size and topology. */
export function fileTimeoutMs(category, fileCount) {
  const aggMiB = FILE_CHUNK_MIB * fileCount;
  const base = category === 'lan' ? 120_000 : 60_000;
  const perMiB = category === 'lan' ? 12_000 : 4_000;
  return Math.min(category === 'lan' ? 900_000 : 600_000, base + aggMiB * perMiB);
}

export function chatTimeoutMs(category) {
  return category === 'lan' ? 300_000 : 120_000;
}
