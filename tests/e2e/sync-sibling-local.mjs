#!/usr/bin/env node
/**
 * Sibling sync local e2e: two processes sharing the same profile secret,
 * empty friend list, must auto-discover and replicate volume events.
 * See `sync-discovery-v1.md` DISC-26 (sibling carriage).
 *
 *   yarn e2e:sibling:local
 */

import { mkdir, rm } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { ensureBenchmarkBuilt } from '../../scripts/ensure-built.mjs';
import { getRepoRoot } from './lib/config.mjs';
import { sleep } from './lib/spawn-bench.mjs';

const WALL_SEC = 25;
const root = getRepoRoot();
const testJs = path.join(root, 'dist/scripts/sync-sibling-test.js');
const runBase = path.join(root, '.local', 'e2e', 'sibling', Date.now().toString());

function spawnRole(role, base) {
  const child = spawn(process.execPath, [testJs], {
    cwd: root,
    env: {
      ...process.env,
      NEARBYTES_TEST_BASE: base,
      NEARBYTES_TEST_ROLE: role,
      NEARBYTES_TEST_PEER_WAIT_MS: '20000',
      NEARBYTES_TEST_POLL_MS: '100',
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

await ensureBenchmarkBuilt();
await rm(runBase, { recursive: true, force: true });
await mkdir(runBase, { recursive: true });

const t0 = Date.now();
console.log(`\n═══ sibling local (${runBase}) — target ≤${WALL_SEC}s ═══\n`);

const a1 = spawnRole('a1', runBase);
await sleep(250);
const a2 = spawnRole('a2', runBase);

await Promise.all([a1.wait(), a2.wait()]);

const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nSibling e2e passed in ${dt}s.`);
