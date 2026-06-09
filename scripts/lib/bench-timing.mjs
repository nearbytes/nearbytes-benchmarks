/**
 * Hard wall-clock budget for benchmark measurement loops.
 *
 * Policy: each workload × system measurement accumulates at most 60 s of
 * trial wall time (sum of rep wallMs). Requests above the cap are clamped;
 * runners must not honor NEARBYTES_* / --target-ms above this limit.
 */
export const HARD_MAX_BENCH_MS = 60_000;
export const DEFAULT_BENCH_TARGET_MS = HARD_MAX_BENCH_MS;
export const HARD_MAX_BENCH_REPEATS = 8;

/**
 * @param {number|string|undefined|null} ms
 * @returns {number}
 */
export function clampBenchTargetMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return HARD_MAX_BENCH_MS;
  return Math.min(Math.round(n), HARD_MAX_BENCH_MS);
}

/**
 * @param {number|string|undefined|null} n
 * @returns {number}
 */
export function clampBenchMaxRepeats(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 3;
  return Math.min(Math.round(v), HARD_MAX_BENCH_REPEATS);
}

/**
 * @param {{ targetMs?: number|string, maxRepeats?: number|string, label?: string }} opts
 * @returns {{ targetMs: number, maxRepeats: number }}
 */
export function resolveBenchRepeatBudget({ targetMs, maxRepeats, label = 'bench' } = {}) {
  const requested = Number(targetMs);
  const capped = clampBenchTargetMs(targetMs);
  if (Number.isFinite(requested) && requested > HARD_MAX_BENCH_MS) {
    process.stderr.write(
      `[${label}] target-ms ${requested} exceeds hard cap ${HARD_MAX_BENCH_MS}ms — using ${capped}ms\n`,
    );
  }
  return { targetMs: capped, maxRepeats: clampBenchMaxRepeats(maxRepeats) };
}

/**
 * Standard measureRepeated loop guard (transfer-matrix, ablation, …).
 * @param {{ runs: unknown[], totalMs: number, targetMs: number, maxRepeats: number }} state
 */
export function shouldTakeAnotherBenchRep({ runs, totalMs, targetMs, maxRepeats }) {
  const budget = resolveBenchRepeatBudget({ targetMs, maxRepeats });
  return runs.length < budget.maxRepeats && totalMs < budget.targetMs;
}

/**
 * Network-bench: stop measured reps once accumulated wall exceeds cap.
 * @param {{ totalMeasuredMs: number, targetMs?: number }} state
 */
export function shouldTakeAnotherNetworkRep({ totalMeasuredMs, targetMs = HARD_MAX_BENCH_MS }) {
  return totalMeasuredMs < clampBenchTargetMs(targetMs);
}
