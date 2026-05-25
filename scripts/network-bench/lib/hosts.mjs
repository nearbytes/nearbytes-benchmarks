/**
 * Host map loader for network-bench.
 *
 * Reads `config/bench-hosts.local.json` (gitignored) so per-environment SSH
 * aliases, IPs, and remote workspace paths never leak into the repo. The
 * matching example file `config/bench-hosts.example.json` lives next to it
 * with placeholder values and IS committed.
 *
 * Public shape:
 *   { local, lan: { alice, bob }, wan: { host, netem, image } }
 * Optional sections may be absent — the corresponding category runner
 * will refuse to run with a clear error message.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
export const HOSTS_PATH = resolve(ROOT, 'config', 'bench-hosts.local.json');

export async function loadHosts() {
  const raw = await readFile(HOSTS_PATH, 'utf8').catch((err) => {
    if (err && err.code === 'ENOENT') {
      throw new Error(
        `bench-hosts.local.json not found at ${HOSTS_PATH}. ` +
          `Copy config/bench-hosts.example.json and edit it for your environment.`,
      );
    }
    throw err;
  });
  return JSON.parse(raw);
}

export function requireLan(hosts) {
  if (!hosts.lan || !hosts.lan.alice || !hosts.lan.bob) {
    throw new Error('hosts.lan.{alice,bob} required for LAN category');
  }
  return hosts.lan;
}

export function requireWan(hosts) {
  if (!hosts.wan || !hosts.wan.host) {
    throw new Error('hosts.wan.host required for WAN category');
  }
  return hosts.wan;
}
