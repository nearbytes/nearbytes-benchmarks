/**
 * Benchmark profiles.
 *
 * | Profile       | Use case                                      |
 * |---------------|-----------------------------------------------|
 * | quick         | CI smoke (≤30s)                               |
 * | latency-only  | Fast latency sweep, no throughput             |
 * | full          | Legacy research run (~3–4 min)                |
 * | paper         | Conference-grade: warmup discard, n≥10, stream  |
 *
 * Set NEARBYTES_BENCH_PROFILE=paper for publication numbers.
 */

export type BenchProfileMode = 'full' | 'quick' | 'latency-only' | 'paper';
export type ThroughputMode = 'batch' | 'stream' | 'none';

export interface BenchProfile {
  readonly mode: BenchProfileMode;
  readonly quick: boolean;
  readonly latencyOnly: boolean;
  readonly payloadSizes: readonly number[];
  readonly receiverPollMs: number;
  readonly latencyRepeats: number;
  /** Discarded warmup payloads per size (not in trial manifest). */
  readonly latencyWarmupRepeats: number;
  readonly throughputMode: ThroughputMode;
  readonly throughputFileBytes: number;
  readonly throughputFileCount: number;
  /** Single-stream size when throughputStreamSizes is empty. */
  readonly throughputStreamBytes: number;
  /** Sustained goodput sweep sizes (paper: 1 / 32 / 128 MiB). */
  readonly throughputStreamSizes: readonly number[];
  readonly streamInterPauseMs: number;
  readonly discoveryMs: number;
  readonly interTrialMs: number;
  readonly graceMs: number;
  readonly swarmTimeoutMs: number;
  /**
   * Max wait (receiver/sender). 0 = event-driven (wait until phase marker or peer ack).
   */
  readonly latencyReceiveTimeoutMs: number;
  readonly throughputReceiveTimeoutMs: number;
  readonly coordinatedTrials: boolean;
  readonly syncReadyTimeoutMs: number;
  readonly trialAckTimeoutMs: number;
}

/** 0 means wait without a wall-clock deadline. */
export function benchTimeoutMs(ms: number): number {
  return ms > 0 ? ms : 0;
}

const FULL_PAYLOAD_SIZES = [
  4 * 1024,
  16 * 1024,
  64 * 1024,
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
] as const;

const PAPER_PAYLOAD_SIZES = [
  4 * 1024,
  64 * 1024,
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
] as const;

const QUICK_PAYLOAD_SIZES = [4 * 1024, 64 * 1024] as const;

const LATENCY_ONLY_SIZES = [4 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024] as const;

const PAPER_STREAM_SIZES = [
  1 * 1024 * 1024,
  32 * 1024 * 1024,
  128 * 1024 * 1024,
] as const;

/** Empty string env (from `VAR= cmd`) must not become 0 via Number(''). */
export function benchEnvMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function benchEnvInt(key: string, fallback: number): number {
  return Math.max(0, Math.floor(benchEnvMs(key, fallback)));
}

export function isQuickBench(): boolean {
  const v = process.env['NEARBYTES_BENCH_QUICK']?.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Comma-separated byte counts, e.g. NEARBYTES_BENCH_STREAM_SIZES=1048576,33554432 */
export function parseStreamSizesEnv(): number[] | null {
  const raw = process.env['NEARBYTES_BENCH_STREAM_SIZES']?.trim();
  if (!raw) return null;
  const sizes = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return sizes.length > 0 ? sizes : null;
}

export function effectiveStreamSizes(profile: BenchProfile): readonly number[] {
  if (profile.throughputStreamSizes.length > 0) return profile.throughputStreamSizes;
  if (profile.throughputStreamBytes > 0) return [profile.throughputStreamBytes];
  return [];
}

export function getBenchProfileMode(): BenchProfileMode {
  const explicit = process.env['NEARBYTES_BENCH_PROFILE']?.toLowerCase();
  if (explicit === 'latency-only' || explicit === 'latency') return 'latency-only';
  if (explicit === 'paper') return 'paper';
  if (explicit === 'quick') return 'quick';
  if (explicit === 'full') return 'full';
  if (isQuickBench()) return 'quick';
  return 'full';
}

export function getBenchProfile(): BenchProfile {
  const mode = getBenchProfileMode();

  if (mode === 'latency-only') {
    return {
      mode,
      quick: true,
      latencyOnly: true,
      payloadSizes: LATENCY_ONLY_SIZES,
      latencyRepeats: benchEnvInt('NEARBYTES_BENCH_LATENCY_REPEATS', 1),
      latencyWarmupRepeats: 0,
      throughputMode: 'none',
      throughputFileBytes: 0,
      throughputFileCount: 0,
      throughputStreamBytes: 0,
      throughputStreamSizes: [],
      streamInterPauseMs: 0,
      discoveryMs: benchEnvMs('NEARBYTES_BENCH_DISCOVERY_MS', 2000),
      interTrialMs: benchEnvMs('NEARBYTES_BENCH_INTER_TRIAL_MS', 0),
      graceMs: benchEnvMs('NEARBYTES_BENCH_GRACE_MS', 1500),
      swarmTimeoutMs: benchEnvMs('NEARBYTES_BENCH_SWARM_TIMEOUT_MS', 12000),
      latencyReceiveTimeoutMs: benchEnvMs('NEARBYTES_BENCH_LATENCY_TIMEOUT_MS', 25000),
      throughputReceiveTimeoutMs: 0,
      receiverPollMs: benchEnvMs('NEARBYTES_BENCH_RECEIVER_POLL_MS', 50),
      coordinatedTrials: false,
      syncReadyTimeoutMs: 0,
      trialAckTimeoutMs: 0,
    };
  }

  if (mode === 'paper') {
    return {
      mode,
      quick: false,
      latencyOnly: false,
      payloadSizes: PAPER_PAYLOAD_SIZES,
      latencyRepeats: benchEnvInt('NEARBYTES_BENCH_LATENCY_REPEATS', 5),
      latencyWarmupRepeats: benchEnvInt('NEARBYTES_BENCH_LATENCY_WARMUP', 1),
      throughputMode: 'stream',
      throughputFileBytes: 0,
      throughputFileCount: 0,
      throughputStreamBytes: benchEnvInt(
        'NEARBYTES_BENCH_STREAM_BYTES',
        32 * 1024 * 1024,
      ),
      throughputStreamSizes: parseStreamSizesEnv() ?? PAPER_STREAM_SIZES,
      streamInterPauseMs: benchEnvMs('NEARBYTES_BENCH_STREAM_INTER_MS', 500),
      discoveryMs: benchEnvMs('NEARBYTES_BENCH_DISCOVERY_MS', 2000),
      interTrialMs: benchEnvMs('NEARBYTES_BENCH_INTER_TRIAL_MS', 25),
      graceMs: benchEnvMs('NEARBYTES_BENCH_GRACE_MS', 3000),
      swarmTimeoutMs: benchEnvMs('NEARBYTES_BENCH_SWARM_TIMEOUT_MS', 0),
      latencyReceiveTimeoutMs: benchEnvMs('NEARBYTES_BENCH_LATENCY_TIMEOUT_MS', 0),
      throughputReceiveTimeoutMs: benchEnvMs('NEARBYTES_BENCH_THROUGHPUT_TIMEOUT_MS', 0),
      receiverPollMs: benchEnvMs('NEARBYTES_BENCH_RECEIVER_POLL_MS', 50),
      coordinatedTrials: true,
      syncReadyTimeoutMs: benchEnvMs('NEARBYTES_BENCH_SYNC_READY_MS', 0),
      trialAckTimeoutMs: benchEnvMs('NEARBYTES_BENCH_TRIAL_ACK_MS', 0),
    };
  }

  if (mode === 'quick') {
    return {
      mode,
      quick: true,
      latencyOnly: false,
      payloadSizes: QUICK_PAYLOAD_SIZES,
      latencyRepeats: 1,
      latencyWarmupRepeats: 0,
      throughputMode: 'batch',
      throughputFileBytes: 64 * 1024,
      throughputFileCount: 2,
      throughputStreamBytes: 0,
      throughputStreamSizes: [],
      streamInterPauseMs: 0,
      discoveryMs: benchEnvMs('NEARBYTES_BENCH_DISCOVERY_MS', 4000),
      interTrialMs: benchEnvMs('NEARBYTES_BENCH_INTER_TRIAL_MS', 200),
      graceMs: benchEnvMs('NEARBYTES_BENCH_GRACE_MS', 4000),
      swarmTimeoutMs: benchEnvMs('NEARBYTES_BENCH_SWARM_TIMEOUT_MS', 15000),
      latencyReceiveTimeoutMs: benchEnvMs('NEARBYTES_BENCH_LATENCY_TIMEOUT_MS', 45000),
      throughputReceiveTimeoutMs: benchEnvMs('NEARBYTES_BENCH_THROUGHPUT_TIMEOUT_MS', 60000),
      receiverPollMs: 250,
      coordinatedTrials: false,
      syncReadyTimeoutMs: 0,
      trialAckTimeoutMs: 0,
    };
  }

  return {
    mode: 'full',
    quick: false,
    latencyOnly: false,
    payloadSizes: FULL_PAYLOAD_SIZES,
    receiverPollMs: 250,
    latencyRepeats: 5,
    latencyWarmupRepeats: 0,
    throughputMode: 'batch',
    throughputFileBytes: 1024 * 1024,
    throughputFileCount: 12,
    throughputStreamBytes: 0,
    throughputStreamSizes: [],
    streamInterPauseMs: 0,
    discoveryMs: benchEnvMs('NEARBYTES_BENCH_DISCOVERY_MS', 18000),
    interTrialMs: benchEnvMs('NEARBYTES_BENCH_INTER_TRIAL_MS', 2500),
    graceMs: benchEnvMs('NEARBYTES_BENCH_GRACE_MS', 35000),
    swarmTimeoutMs: benchEnvMs('NEARBYTES_BENCH_SWARM_TIMEOUT_MS', 120000),
    latencyReceiveTimeoutMs: benchEnvMs('NEARBYTES_BENCH_LATENCY_TIMEOUT_MS', 600000),
    throughputReceiveTimeoutMs: benchEnvMs('NEARBYTES_BENCH_THROUGHPUT_TIMEOUT_MS', 300000),
    coordinatedTrials: false,
    syncReadyTimeoutMs: 0,
    trialAckTimeoutMs: 0,
  };
}
