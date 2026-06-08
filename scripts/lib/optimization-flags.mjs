/**
 * Harness-side optimization flags (mirrors src/optimization-flags.ts).
 * All optimizations default ON; disable with NEARBYTES_OPT_*=0 or --opt-off.
 */

export const OPT_DEFS = [
  { id: 'burst-parallel', env: 'NEARBYTES_OPT_BURST_PARALLEL', sync: false },
  { id: 'pregen-payload', env: 'NEARBYTES_OPT_PREGEN_PAYLOAD', sync: false },
  { id: 'overlap-expect', env: 'NEARBYTES_OPT_OVERLAP_EXPECT', sync: false },
  { id: 'inflight-dedup', env: 'NEARBYTES_OPT_INFLIGHT_DEDUP', sync: true },
  { id: 'tcp-bulk', env: 'NEARBYTES_OPT_TCP_BULK', sync: true },
  { id: 'hash-pool', env: 'NEARBYTES_OPT_HASH_POOL', sync: true },
];

const OPT_BY_ID = new Map(OPT_DEFS.map((d) => [d.id, d]));

export function optEnabled(envName, defaultOn = true) {
  const v = process.env[envName];
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  return defaultOn;
}

export function parseOptArgv(argv = process.argv) {
  const off = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--opt-off' && argv[i + 1]) {
      off.add(argv[++i]);
    }
  }
  return off;
}

/** Env map with all opts on except those in `disabled` (Set of ids). */
export function envForOpts(disabled = new Set(), base = process.env) {
  const env = { ...base };
  for (const def of OPT_DEFS) {
    env[def.env] = disabled.has(def.id) ? '0' : '1';
  }
  if (disabled.has('hash-pool')) {
    env.NEARBYTES_HASH_POOL_CAPACITY = '1';
  }
  return env;
}

export function ablationConfigs() {
  const configs = [{ id: 'all-on', label: 'All optimizations (default)', disabled: new Set() }];
  for (const def of OPT_DEFS) {
    configs.push({
      id: `off-${def.id}`,
      label: `Disable: ${def.id}`,
      disabled: new Set([def.id]),
    });
  }
  return configs;
}

export function applyOptArgvToEnv(argv = process.argv, env = process.env) {
  return envForOpts(parseOptArgv(argv), env);
}

export function assertKnownOpt(id) {
  if (!OPT_BY_ID.has(id)) {
    throw new Error(`unknown opt ${id}; known: ${OPT_DEFS.map((d) => d.id).join(', ')}`);
  }
}

/** Space-separated KEY=val for remote `exec env` (values shell-quoted). */
export function optEnvShell() {
  const parts = OPT_DEFS.map((d) => `${d.env}=${shq(process.env[d.env] ?? '1')}`);
  if (process.env.NEARBYTES_HASH_POOL_CAPACITY != null) {
    parts.push(`NEARBYTES_HASH_POOL_CAPACITY=${shq(process.env.NEARBYTES_HASH_POOL_CAPACITY)}`);
  }
  return parts.join(' ');
}

function shq(s) {
  const t = String(s);
  if (/^[A-Za-z0-9_./:-]+$/.test(t)) return t;
  return `'${t.replace(/'/g, `'\\''`)}'`;
}
