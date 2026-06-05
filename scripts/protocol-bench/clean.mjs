#!/usr/bin/env node
/**
 * Stop stray protocol peers and wipe protocol bench artefacts.
 */
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROTO = join(REPO_ROOT, '.local/bench/protocol');

async function main() {
  try {
    execSync('pkill -f "dist/scripts/protocol-peer.js" 2>/dev/null || true', { stdio: 'ignore' });
  } catch {
    /* ignore */
  }

  for (const sub of ['db', 'pair-local']) {
    const p = join(PROTO, sub);
    if (existsSync(p)) {
      await rm(p, { recursive: true, force: true });
      process.stdout.write(`removed ${p}\n`);
    }
  }

  for (const f of ['local-results.json', 'lan-results.json', 'local-manifest.json', 'lan-manifest.json']) {
    const p = join(PROTO, f);
    if (existsSync(p)) {
      await rm(p, { force: true });
      process.stdout.write(`removed ${p}\n`);
    }
  }

  process.stdout.write('protocol bench clean done\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
