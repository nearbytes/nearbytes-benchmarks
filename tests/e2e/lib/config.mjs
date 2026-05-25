import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function getRepoRoot() {
  return repoRoot;
}

export function resolveRepoPath(rel) {
  if (!rel || path.isAbsolute(rel)) return rel ?? repoRoot;
  return path.join(repoRoot, rel);
}

export async function loadE2eConfig() {
  const explicit = process.env['NEARBYTES_E2E_CONFIG'];
  const localPath = explicit ?? path.join(repoRoot, 'config/e2e.local.json');
  const examplePath = path.join(repoRoot, 'config/e2e.local.example.json');
  for (const p of [localPath, examplePath]) {
    try {
      const raw = await readFile(p, 'utf-8');
      return { ...JSON.parse(raw), _configPath: p };
    } catch (err) {
      console.warn(`[e2e] config not readable at ${p}:`, err.message);
    }
  }
  throw new Error(
    `No e2e config found. Copy config/e2e.local.example.json to config/e2e.local.json`,
  );
}

export async function getRemoteHost() {
  const cfg = await loadE2eConfig();
  return process.env['NEARBYTES_REMOTE_HOST'] ?? cfg.remoteHost;
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
    paperFiguresDir: resolveRepoPath(cfg.paperFiguresDir),
    sshConnectTimeoutSec: Number(
      process.env['NEARBYTES_SSH_CONNECT_TIMEOUT'] ?? cfg.sshConnectTimeoutSec ?? 10,
    ),
  };
}
