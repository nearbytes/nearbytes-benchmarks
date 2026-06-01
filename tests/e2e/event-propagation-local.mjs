#!/usr/bin/env node
/** Loopback propagation bench — delegates to nearbytes-files runner (~5s target, 20s wall). */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { getRepoRoot } from './lib/config.mjs';

const filesRoot = join(getRepoRoot(), '..', 'nearbytes-files');
const WALL_MS = Number(process.env.NBF_PROP_WALL_MS ?? 20_000);
const child = spawn('yarn', ['probe:event-propagation'], {
  cwd: filesRoot,
  env: {
    ...process.env,
    NBF_PROP_PEER_TIMEOUT_MS: process.env.NBF_PROP_PEER_TIMEOUT_MS ?? '3000',
    NBF_PROP_MEASURE_TIMEOUT_MS: process.env.NBF_PROP_MEASURE_TIMEOUT_MS ?? '2000',
    NBF_PROP_WALL_MS: String(WALL_MS),
  },
  stdio: 'inherit',
});
const timer = setTimeout(() => {
  child.kill('SIGTERM');
}, WALL_MS);
child.on('exit', (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});
