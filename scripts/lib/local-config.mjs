/**
 * Unified local config: machines for benchmarks + e2e path overrides.
 *
 * Primary:   config/local.json (gitignored)
 * Example:   config/local.example.json
 * Legacy:    config/bench-hosts.local.json + config/e2e.local.json
 */
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BENCH_TARGET_MS, clampBenchTargetMs } from './bench-timing.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const LOCAL_CONFIG_PATH = resolve(ROOT, 'config', 'local.json');
export const LOCAL_CONFIG_EXAMPLE = resolve(ROOT, 'config', 'local.example.json');
export const LEGACY_HOSTS_PATH = resolve(ROOT, 'config', 'bench-hosts.local.json');
export const LEGACY_E2E_PATH = resolve(ROOT, 'config', 'e2e.local.json');
export { DEFAULT_BENCH_TARGET_MS };

async function readable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function hostsFromRaw(raw) {
  if (raw.machines) {
    return {
      local: raw.machines.local,
      lan: raw.machines.lan,
      wan: raw.machines.wan,
    };
  }
  return { local: raw.local, lan: raw.lan, wan: raw.wan };
}

function e2eFromRaw(raw, hosts) {
  if (raw.e2e && typeof raw.e2e === 'object') {
    return { ...raw.e2e };
  }
  const legacy = {
    remoteHost: raw.remoteHost,
    remoteFilesRoot: raw.remoteFilesRoot,
    sshConnectTimeoutSec: raw.sshConnectTimeoutSec,
    benchBaseLocal: raw.benchBaseLocal,
    benchBaseRemote: raw.benchBaseRemote,
    benchReportsDir: raw.benchReportsDir,
    e2eWorkDir: raw.e2eWorkDir,
    reportFiguresDir: raw.reportFiguresDir,
  };
  const defined = Object.fromEntries(
    Object.entries(legacy).filter(([, v]) => v !== undefined),
  );
  if (Object.keys(defined).length > 0) {
    return defined;
  }
  return {
    remoteHost: hosts?.lan?.alice?.ssh ?? null,
    remoteFilesRoot: '/tmp/nearbytes-files',
    sshConnectTimeoutSec: 15,
    benchBaseLocal: '.local/bench/work',
    benchBaseRemote: '/tmp/nearbytes-sync-benchmark',
    benchReportsDir: '.local/bench/reports',
    e2eWorkDir: '.local/e2e/work',
    reportFiguresDir: '.local/bench/figures',
  };
}

export function benchTargetMs(raw) {
  const fromCfg = raw?.bench?.targetMs ?? raw?.targetMs;
  if (fromCfg != null) return clampBenchTargetMs(fromCfg);
  const fromEnv = process.env.NEARBYTES_TRANSFER_TARGET_MS;
  if (fromEnv != null && fromEnv !== '') return clampBenchTargetMs(fromEnv);
  return DEFAULT_BENCH_TARGET_MS;
}

export async function loadLocalConfig() {
  const explicit = process.env.NEARBYTES_LOCAL_CONFIG;
  if (explicit) {
    const raw = await readJson(explicit);
    return { raw, hosts: hostsFromRaw(raw), e2e: e2eFromRaw(raw, hostsFromRaw(raw)), _configPath: explicit };
  }

  if (await readable(LOCAL_CONFIG_PATH)) {
    const raw = await readJson(LOCAL_CONFIG_PATH);
    const hosts = hostsFromRaw(raw);
    return { raw, hosts, e2e: e2eFromRaw(raw, hosts), _configPath: LOCAL_CONFIG_PATH };
  }

  let hostsRaw = null;
  let e2eRaw = null;
  if (await readable(LEGACY_HOSTS_PATH)) {
    hostsRaw = await readJson(LEGACY_HOSTS_PATH);
  }
  if (await readable(LEGACY_E2E_PATH)) {
    e2eRaw = await readJson(LEGACY_E2E_PATH);
  }

  if (hostsRaw || e2eRaw) {
    const merged = { ...(hostsRaw ?? {}), ...(e2eRaw ?? {}) };
    const hosts = hostsFromRaw(merged);
    return {
      raw: merged,
      hosts,
      e2e: e2eFromRaw(merged, hosts),
      _configPath: hostsRaw ? LEGACY_HOSTS_PATH : LEGACY_E2E_PATH,
    };
  }

  if (await readable(LOCAL_CONFIG_EXAMPLE)) {
    throw new Error(
      `config/local.json not found. Copy config/local.example.json to config/local.json and edit machines for your environment.`,
    );
  }

  throw new Error('No local config found (config/local.json or legacy bench-hosts/e2e files).');
}

/** Path to sync to remote orchestrators (prefers unified local.json). */
export async function resolveConfigSyncPath() {
  if (process.env.NEARBYTES_LOCAL_CONFIG) {
    return process.env.NEARBYTES_LOCAL_CONFIG;
  }
  if (await readable(LOCAL_CONFIG_PATH)) {
    return LOCAL_CONFIG_PATH;
  }
  if (await readable(LEGACY_HOSTS_PATH)) {
    return LEGACY_HOSTS_PATH;
  }
  throw new Error('No config file to sync to remote hosts (need config/local.json).');
}
