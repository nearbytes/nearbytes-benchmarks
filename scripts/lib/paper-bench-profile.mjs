/**
 * Paper evaluation timing — hard 60s cap per measurement (see bench-timing.mjs).
 */
import { HARD_MAX_BENCH_MS, clampBenchMaxRepeats } from './bench-timing.mjs';

const TARGET_MS = String(HARD_MAX_BENCH_MS);
const MAX_REPEATS = String(clampBenchMaxRepeats(3));

/** @deprecated no-op; kept so old env does not break scripts */
export const FULL = false;

/** Paper figures only need these rows per topology (see bench-sanity TM_NETWORK_NEARBYTES). */
const TM_CASES = {
  local: null,
  lan: ['64MiB_512KiB_x128_burst', '128MiB_x1_seq'],
  wan: ['64MiB_1MiB_x64_burst', '128MiB_x1_seq'],
};

export function transferMatrixEnv(category = 'local') {
  const env = {
    NEARBYTES_TRANSFER_TARGET_MS: TARGET_MS,
    NEARBYTES_TRANSFER_MAX_REPEATS: MAX_REPEATS,
  };
  const cases = TM_CASES[category];
  if (cases?.length) env.NEARBYTES_TRANSFER_MATRIX_CASES = cases.join(',');
  return env;
}

export function transferMatrixArgv(category = 'local') {
  const args = ['--target-ms', TARGET_MS, '--max-repeats', MAX_REPEATS];
  const cases = TM_CASES[category];
  if (cases?.length) args.push('--cases', cases.join(','));
  return args;
}

export function ablationArgv(outPath) {
  return [
    '--out', outPath,
    '--skip-build',
    '--target-ms', TARGET_MS,
    '--max-repeats', MAX_REPEATS,
    '--cases', '64MiB_4MiB_x16_burst,128MiB_x1_seq',
  ];
}

export function ablationEnv() {
  return {
    NEARBYTES_OPT_OVERLAP_EXPECT: '0',
    NEARBYTES_ABLATION_TARGET_MS: TARGET_MS,
    NEARBYTES_ABLATION_MAX_REPEATS: MAX_REPEATS,
  };
}

export function profileLabel() {
  return `standard (≤${HARD_MAX_BENCH_MS / 1000}s cap per measurement)`;
}
