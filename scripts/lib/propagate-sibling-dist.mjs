#!/usr/bin/env node
/**
 * Mirror freshly built sibling `dist/` trees into nested node_modules copies.
 * Yarn git deps snapshot sources once; local edits require this step.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE_ROOT = resolve(BENCH_ROOT, '..');

const PKGS = [
  'nearbytes-log',
  'nearbytes-sync',
  'nearbytes-skeleton',
  'nearbytes-chat',
  'nearbytes-files',
  'nearbytes-engine',
];

for (const pkg of PKGS) {
  const src = resolve(CODE_ROOT, pkg, 'dist');
  if (!existsSync(src)) {
    console.warn(`skip ${pkg}: no dist at ${src}`);
    continue;
  }
  const cmd = `find ${JSON.stringify(BENCH_ROOT)} -path '*/node_modules/${pkg}/dist' -type d 2>/dev/null`;
  const out = execSync(cmd, { encoding: 'utf8' }).trim();
  if (!out) {
    console.warn(`skip ${pkg}: no nested node_modules copy`);
    continue;
  }
  for (const dst of out.split('\n').filter(Boolean)) {
    execSync(`rm -rf ${JSON.stringify(dst)} && mkdir -p ${JSON.stringify(dirname(dst))} && cp -a ${JSON.stringify(src)} ${JSON.stringify(dst)}`);
    console.log(`propagated ${pkg} -> ${dst}`);
  }
}
