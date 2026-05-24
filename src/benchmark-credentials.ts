/** Well-known credentials for reproducible cross-host benchmarks (not for production). */
export const BENCH_CREDENTIALS = {
  profileAlice: 'nearbytes-alice:beautiful-document',
  profileBob: 'nearbytes-bob:beautiful-document',
  volume: 'nearbytes-bench:beautiful-document',
  displayAlice: 'NearBytes Bench Alice',
  displayBob: 'NearBytes Bench Bob',
} as const;

export const BENCH_PAYLOAD_SIZES = [
  4 * 1024,
  16 * 1024,
  64 * 1024,
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
] as const;

export const BENCH_LATENCY_REPEATS = 5;
export const BENCH_THROUGHPUT_FILE_BYTES = 1024 * 1024;
export const BENCH_THROUGHPUT_FILE_COUNT = 12;
