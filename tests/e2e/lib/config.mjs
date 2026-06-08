import path from 'path';
import { fileURLToPath } from 'url';

import { loadLocalConfig } from '../../../scripts/lib/local-config.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function getRepoRoot() {
  return repoRoot;
}

export function resolveRepoPath(rel) {
  if (!rel || path.isAbsolute(rel)) return rel ?? repoRoot;
  return path.join(repoRoot, rel);
}

export async function loadE2eConfig() {
  const { e2e, hosts, _configPath } = await loadLocalConfig();
  const remoteHost =
    process.env['NEARBYTES_REMOTE_HOST'] ??
    e2e.remoteHost ??
    hosts?.lan?.alice?.ssh ??
    null;
  return {
    ...e2e,
    remoteHost,
    _configPath,
  };
}

export async function getRemoteHost() {
  const cfg = await loadE2eConfig();
  if (!cfg.remoteHost) {
    throw new Error('e2e.remoteHost or machines.lan.alice.ssh required in config/local.json');
  }
  return cfg.remoteHost;
}

export async function getRemoteFilesRoot() {
  const cfg = await loadE2eConfig();
  return (
    process.env['NBF_PROP_REMOTE_FILES_ROOT'] ??
    cfg.remoteFilesRoot ??
    '/home/vincenzo/data/local/repos/NEARBYTES/nearbytes-files'
  );
}

export async function getBenchPaths() {
  const cfg = await loadE2eConfig();
  return {
    benchBaseLocal: resolveRepoPath(
      process.env['NEARBYTES_BENCH_BASE'] ?? cfg.benchBaseLocal,
    ),
    benchBaseRemote:
      process.env['NEARBYTES_BENCH_BASE_REMOTE'] ?? cfg.benchBaseRemote,
    benchReportsDir: resolveRepoPath(
      process.env['NEARBYTES_BENCH_OUTDIR'] ?? cfg.benchReportsDir,
    ),
    e2eWorkDir: resolveRepoPath(process.env['NEARBYTES_E2E_WORK'] ?? cfg.e2eWorkDir),
    reportFiguresDir: resolveRepoPath(
      process.env['NEARBYTES_REPORT_FIGURES_DIR'] ?? cfg.reportFiguresDir,
    ),
    sshConnectTimeoutSec: Number(
      process.env['NEARBYTES_SSH_CONNECT_TIMEOUT'] ?? cfg.sshConnectTimeoutSec ?? 10,
    ),
  };
}
