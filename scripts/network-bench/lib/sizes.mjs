/**
 * Payload size triplets per category, tuned so each category's full sweep
 * (small + large + burst) × (nearbytes + 2 baselines) × repeats finishes
 * within roughly 60–120 seconds on the target topology.
 *
 *   small  — single tiny file; isolates connection setup / first-byte latency
 *   large  — single bulk file; isolates steady-state goodput
 *   burst  — N concurrent files; exercises pool concurrency + per-file tail
 *
 * Repeats include a discarded warmup. Sizes shrink on WAN because the
 * 100 Mbps / 50 ms RTT shape dominates wall time.
 */

export const SIZES = {
  local: {
    small: { count: 1, bytes: 64 * 1024 },
    large: { count: 1, bytes: 128 * 1024 * 1024 },
    burst: { count: 16, bytes: 8 * 1024 * 1024 },
  },
  lan: {
    small: { count: 1, bytes: 64 * 1024 },
    large: { count: 1, bytes: 128 * 1024 * 1024 },
    burst: { count: 16, bytes: 8 * 1024 * 1024 },
  },
  wan: {
    small: { count: 1, bytes: 64 * 1024 },
    large: { count: 1, bytes: 32 * 1024 * 1024 },
    burst: { count: 8, bytes: 4 * 1024 * 1024 },
  },
};

export const REPEATS = {
  local: { warmup: 1, measured: 5 },
  lan: { warmup: 1, measured: 5 },
  wan: { warmup: 1, measured: 3 },
};

export function totalBytes(plan) {
  return plan.count * plan.bytes;
}

export function describeSize(plan) {
  if (plan.count === 1) return formatBytes(plan.bytes);
  return `${plan.count} × ${formatBytes(plan.bytes)}`;
}

export function formatBytes(b) {
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(b % (1024 * 1024) === 0 ? 0 : 1)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KiB`;
  return `${b} B`;
}
