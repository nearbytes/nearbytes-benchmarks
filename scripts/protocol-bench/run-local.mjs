#!/usr/bin/env node
/**
 * Protocol benchmark — loopback.
 * Per-trial JSON + logs under `.local/bench/protocol/db/local-<stamp>/`.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { collectLocalHostInfo } from '../network-bench/lib/hostinfo.mjs';
import { ProtocolPair, ensureProtocolPeerBuilt } from './lib/protocol-pair.mjs';
import { runProtocolSuite } from './lib/run-suite.mjs';
import { runDir } from './lib/record.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outDir = arg('--outdir', runDir(REPO_ROOT, 'local'));
const summaryLink = arg('--summary', join(REPO_ROOT, '.local/bench/protocol/local-results.json'));

async function main() {
  if (!process.env.NEARBYTES_PROTOCOL_MATRIX) {
    process.env.NEARBYTES_PROTOCOL_MATRIX = 'local,chat-replay';
  }
  await ensureProtocolPeerBuilt();
  const host = await collectLocalHostInfo();
  await runProtocolSuite({
    category: 'local',
    repoRoot: REPO_ROOT,
    outDir,
    summaryLink,
    machines: { local: host },
    startPair: () =>
      ProtocolPair.startLocal(join(REPO_ROOT, '.local/bench/protocol/pair-local')),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
