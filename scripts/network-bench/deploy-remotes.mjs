#!/usr/bin/env node
/** Deploy nearbytes-benchmarks to all remote hosts used by LAN/WAN benches (once per paper run). */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { loadHosts } from './lib/hosts.mjs';
import { ensureRemoteWorkspace } from './lib/deploy.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = join(REPO, '.local', 'bench', 'deploy-stamp.json');
const MAX_AGE_MS = Number(process.env.NEARBYTES_DEPLOY_MAX_AGE_MS ?? 3600_000);

async function main() {
  if (existsSync(STAMP) && !process.argv.includes('--force')) {
    const stamp = JSON.parse(await readFile(STAMP, 'utf8'));
    const age = Date.now() - stamp.deployedAt;
    if (age < MAX_AGE_MS) {
      console.log(`deploy skip (stamp ${Math.round(age / 1000)}s old)`);
      return;
    }
  }
  const hosts = await loadHosts();
  const sshSet = new Set();
  for (const key of ['lan', 'wan']) {
    const block = hosts[key];
    if (!block) continue;
    if (block.alice?.ssh && block.alice.ssh !== 'local') sshSet.add(block.alice.ssh);
    if (block.bob?.ssh) sshSet.add(block.bob.ssh);
  }
  const sshHosts = [...sshSet];
  if (sshHosts.length === 0) {
    console.log('no remote hosts to deploy');
    return;
  }
  function workdirFor(ssh) {
    for (const block of [hosts.lan, hosts.wan].filter(Boolean)) {
      for (const role of ['alice', 'bob']) {
        const h = block[role];
        if (h?.ssh === ssh && h.workdir) return h.workdir;
      }
    }
    return '~/nearbytes-bench';
  }
  console.log(`deploying to ${sshHosts.join(', ')}…`);
  const t0 = Date.now();
  await Promise.all(sshHosts.map((ssh) => ensureRemoteWorkspace(ssh, workdirFor(ssh))));
  await mkdir(dirname(STAMP), { recursive: true });
  await writeFile(STAMP, JSON.stringify({ deployedAt: Date.now(), hosts: sshHosts, ms: Date.now() - t0 }, null, 2));
  console.log(`deploy done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
