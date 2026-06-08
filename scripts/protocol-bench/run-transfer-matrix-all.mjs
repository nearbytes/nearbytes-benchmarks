#!/usr/bin/env node
/**
 * Default benchmark: LOCAL + LAN (detached) + WAN transfer matrix, 30s target, baselines on.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { benchTargetMs, loadLocalConfig } from '../lib/local-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: ROOT, env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

async function main() {
  const { raw } = await loadLocalConfig();
  const targetMs = String(benchTargetMs(raw));

  process.stderr.write(
    `\n=== bench (default): local + lan detached + wan | target=${targetMs}ms | baselines=yes ===\n\n`,
  );

  process.stderr.write('── LAN (detached on alice; Mac may disconnect) ──\n');
  await run('bash', ['scripts/protocol-bench/run-transfer-matrix-lan-detached.sh']);

  process.stderr.write('\n── LOCAL (loopback) ──\n');
  await run('node', [
    'scripts/protocol-bench/run-transfer-matrix.mjs',
    '--',
    '--categories',
    'local',
    '--target-ms',
    targetMs,
    '--out',
    '.local/bench/protocol/transfer-matrix-local.json',
  ]);

  process.stderr.write('\n── WAN (orchestrator ↔ remote bob) ──\n');
  await run('node', [
    'scripts/protocol-bench/run-transfer-matrix.mjs',
    '--',
    '--categories',
    'wan',
    '--target-ms',
    targetMs,
    '--out',
    '.local/bench/protocol/transfer-matrix-wan.json',
  ]);

  process.stderr.write(
    `\n=== done (local + wan on this machine). LAN still running on alice — pull later: yarn bench:lan:pull ===\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
