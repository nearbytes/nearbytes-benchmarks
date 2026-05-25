#!/usr/bin/env node
/**
 * Load config/e2e.local.json and run the remote benchmark shell driver.
 *
 *   yarn e2e:remote
 *   yarn e2e:remote:latency
 */

import { spawn } from 'child_process';
import path from 'path';
import { getBenchPaths, getRemoteHost, getRepoRoot } from './lib/config.mjs';

const campaign = process.argv.includes('--campaign');
const profile = process.argv.includes('--latency')
  ? 'latency-only'
  : campaign
    ? 'campaign'
    : null;
const quick = process.argv.includes('--quick') && !campaign;
const repoRoot = getRepoRoot();
const paths = await getBenchPaths();
const remoteHost = await getRemoteHost();

const env = {
  ...process.env,
  NEARBYTES_REMOTE_HOST: remoteHost,
  NEARBYTES_BENCH_BASE: paths.benchBaseLocal,
  NEARBYTES_BENCH_BASE_REMOTE: paths.benchBaseRemote,
  NEARBYTES_SSH_CONNECT_TIMEOUT: String(paths.sshConnectTimeoutSec),
};
if (profile === 'latency-only') {
  env.NEARBYTES_BENCH_PROFILE = profile;
  env.NEARBYTES_BENCH_OUTDIR = path.join(paths.benchReportsDir, 'remote-latency');
  env.NEARBYTES_BENCH_SKIP_FIGURES = '1';
} else if (profile === 'campaign') {
  env.NEARBYTES_BENCH_PROFILE = 'campaign';
  env.NEARBYTES_BENCH_OUTDIR = path.join(paths.benchReportsDir, 'remote-campaign');
} else if (quick) {
  env.NEARBYTES_BENCH_QUICK = '1';
  env.NEARBYTES_BENCH_OUTDIR = path.join(paths.benchReportsDir, 'remote-quick');
} else {
  env.NEARBYTES_BENCH_OUTDIR = path.join(paths.benchReportsDir, 'remote-full');
}

const script = path.join(repoRoot, 'scripts/run-sync-benchmark-remote.sh');
const child = spawn('bash', [script], { cwd: repoRoot, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
