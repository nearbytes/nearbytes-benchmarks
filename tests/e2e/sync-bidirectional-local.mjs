#!/usr/bin/env node
/**
 * Fast bidirectional friend-sync on one machine (~10s wall, 1 MiB each way).
 * Writes bidirectional JSON report under .local/e2e/.
 *
 *   yarn e2e:bidirectional:local
 */

import { mkdir, rm, access } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { getRepoRoot } from './lib/config.mjs';
import { sleep } from './lib/spawn-bench.mjs';

const WALL_SEC = 12;
const FAST_ENV = {
  NEARBYTES_TEST_PAYLOAD_BYTES: '1048576',
  NEARBYTES_TEST_WARMUP_MS: '200',
  NEARBYTES_TEST_PEER_WAIT_MS: '8000',
  NEARBYTES_TEST_TIMEOUT_MS: '8000',
  NEARBYTES_TEST_POLL_MS: '50',
  NEARBYTES_TEST_GRACE_MS: '300',
};

const root = getRepoRoot();
const testJs = path.join(root, 'dist/scripts/sync-bidirectional-test.js');
const runBase = path.join(root, '.local', 'e2e', 'bidirectional', Date.now().toString());
const reportDir = path.join(root, '.local', 'e2e', 'reports', 'bidirectional');

async function ensureBuilt() {
  try {
    await access(testJs);
  } catch {
    console.log('Building nearbytes-benchmarks…');
    await new Promise((res, rej) => {
      const b = spawn('yarn', ['build'], { cwd: root, stdio: 'inherit' });
      b.on('exit', (c) => (c === 0 ? res() : rej(new Error(`build exit ${c}`))));
    });
  }
}

function spawnRole(role, base) {
  const child = spawn(process.execPath, [testJs], {
    cwd: root,
    env: {
      ...process.env,
      ...FAST_ENV,
      NEARBYTES_TEST_BASE: base,
      NEARBYTES_TEST_ROLE: role,
      NEARBYTES_TEST_OUT: path.join(base, role, 'bidirectional-result.json'),
    },
    stdio: 'inherit',
  });
  const wall = setTimeout(() => {
    console.error(`[${role}] wall ${WALL_SEC}s — SIGTERM`);
    child.kill('SIGTERM');
  }, WALL_SEC * 1000);
  return {
    wait: () =>
      new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => {
          clearTimeout(wall);
          if (code === 0 || code === 143 || code === null) resolve();
          else reject(new Error(`${role} exited ${code}`));
        });
      }),
  };
}

await ensureBuilt();
await rm(runBase, { recursive: true, force: true });
await mkdir(runBase, { recursive: true });
await mkdir(reportDir, { recursive: true });

const t0 = Date.now();
console.log(`\n═══ bidirectional local (${runBase}) — target ≤${WALL_SEC}s, 1 MiB each way ═══\n`);

const bob = spawnRole('bob', runBase);
await sleep(250);
const alice = spawnRole('alice', runBase);

await Promise.all([bob.wait(), alice.wait()]);

const reportPath = path.join(reportDir, 'sync-report.json');
await new Promise((res, rej) => {
  const m = spawn(
    process.execPath,
    [
      path.join(root, 'scripts/merge-bidirectional-report.mjs'),
      '--alice',
      path.join(runBase, 'alice/bidirectional-result.json'),
      '--bob',
      path.join(runBase, 'bob/bidirectional-result.json'),
      '--out',
      reportPath,
      '--topology',
      'localhost bidirectional (two processes, 1 MiB each way)',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  m.on('exit', (c) => (c === 0 ? res() : rej(new Error(`merge exit ${c}`))));
});

const report = JSON.parse(await (await import('fs/promises')).readFile(reportPath, 'utf-8'));

// TEST-21: assert the outcome. Reaching this line only proves both roles exited
// without crashing; it says nothing about whether the two peers converged, and
// a run that transfers nothing at all still gets here.
const failures = [];
for (const role of ['alice', 'bob']) {
  const phase = report.phases?.[role];
  if (!phase) failures.push(`${role}: no phase data in report`);
  else if (phase.friendSessionMs == null) failures.push(`${role}: never established a friend session`);
  else if (phase.receiveMs == null) failures.push(`${role}: never completed a receive`);
}
if (failures.length > 0) {
  console.error(`\nBidirectional e2e FAILED:\n  - ${failures.join('\n  - ')}`);
  console.error(`Report: ${reportPath}`);
  process.exit(1);
}
console.log(`\nBidirectional e2e passed in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
console.log(`Report: ${reportPath}`);
if (report.phases?.alice) {
  console.log(
    `Phases — Alice: boot ${report.phases.alice.bootMs}ms, friend ${report.phases.alice.friendSessionMs}ms, recv ${report.phases.alice.receiveMs}ms`,
  );
}
if (report.phases?.bob) {
  console.log(
    `Phases — Bob: boot ${report.phases.bob.bootMs}ms, friend ${report.phases.bob.friendSessionMs}ms, recv ${report.phases.bob.receiveMs}ms`,
  );
}
if (report.throughput?.receiverGoodputMbps != null) {
  console.log(`Goodput (approx): ${report.throughput.receiverGoodputMbps.toFixed(1)} Mb/s`);
}
