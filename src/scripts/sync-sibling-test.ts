/**
 * Sibling sync integration test (`sync-discovery-v1.md` DISC-26).
 *
 *   NEARBYTES_TEST_ROLE=a1|a2  node dist/scripts/sync-sibling-test.js
 *
 * Two processes that share the same profile secret (i.e. the same identity
 * on two devices) and have an EMPTY friends list. Sibling carriage MUST
 * auto-discover them and replicate volume events both directions without
 * any explicit `friend add`.
 */

import { mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { writeConfig, readConfig, type NearbytesConfig } from 'nearbytes-skeleton';
import { createProbeRuntime as createContext, openAndWatch } from 'nearbytes-files/probe-runtime';

const SHARED_PROFILE_SECRET = 'nearbytes-vincenzo:sibling-shared-strong-secret';
const VOLUME_SECRET = 'nearbytes-sibling-test:beautiful-document';
const FILE_NAME_A1 = 'from-a1.bin';
const FILE_NAME_A2 = 'from-a2.bin';

type Role = 'a1' | 'a2';

function roleFromEnv(): Role {
  const raw = process.env['NEARBYTES_TEST_ROLE']?.toLowerCase();
  if (raw === 'a1' || raw === 'a2') return raw;
  throw new Error('Set NEARBYTES_TEST_ROLE=a1 or NEARBYTES_TEST_ROLE=a2');
}

function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function payload(role: Role): Buffer {
  const size = envMs('NEARBYTES_TEST_PAYLOAD_BYTES', 64 * 1024);
  const buf = Buffer.alloc(size);
  const seed = role === 'a1' ? 0xa1 : 0xa2;
  for (let i = 0; i < size; i++) buf[i] = (i * 17 + seed) & 0xff;
  return buf;
}

function dirs(role: Role): { configPath: string; dataDir: string; workDir: string } {
  const base =
    process.env['NEARBYTES_TEST_BASE'] ??
    path.join(os.tmpdir(), 'nearbytes-sync-sibling-test');
  const workDir = path.join(base, role);
  return {
    workDir,
    configPath: path.join(workDir, 'config.json'),
    dataDir: path.join(workDir, 'data'),
  };
}

async function setupConfig(role: Role): Promise<string> {
  const { configPath, dataDir, workDir } = dirs(role);
  if (existsSync(workDir)) await rm(workDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });

  const config: NearbytesConfig = {
    dataDir,
    volumes: [],
    friends: [],
    profiles: [{ name: 'vincenzo', secret: SHARED_PROFILE_SECRET }],
    activeProfile: 'vincenzo',
  };

  process.env['NEARBYTES_CONFIG'] = configPath;
  process.env['NEARBYTES_STORAGE_DIR'] = dataDir;
  await writeConfig(config, configPath);
  return configPath;
}

async function waitFor<T>(check: () => Promise<T | null>, timeoutMs: number, pollMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('sibling sync timeout');
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function main(): Promise<void> {
  const role = roleFromEnv();
  const configPath = await setupConfig(role);
  const config = await readConfig(configPath);

  const ctx = await createContext(config);
  await openAndWatch(ctx, VOLUME_SECRET);

  const myName = role === 'a1' ? FILE_NAME_A1 : FILE_NAME_A2;
  const peerName = role === 'a1' ? FILE_NAME_A2 : FILE_NAME_A1;

  await ctx.fileService.addFile(VOLUME_SECRET, myName, payload(role));

  const peerWaitMs = envMs('NEARBYTES_TEST_PEER_WAIT_MS', 15_000);
  const pollMs = envMs('NEARBYTES_TEST_POLL_MS', 100);

  await waitFor(
    async () => {
      const list = await ctx.fileService.listFiles(VOLUME_SECRET);
      const seen = list.some((f) => f.filename === peerName);
      return seen ? true : null;
    },
    peerWaitMs,
    pollMs,
  );

  const list = await ctx.fileService.listFiles(VOLUME_SECRET);
  const names = list.map((f) => f.filename).sort();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ role, files: names }));
  if (!names.includes(FILE_NAME_A1) || !names.includes(FILE_NAME_A2)) {
    throw new Error(`expected both files, got: ${names.join(',')}`);
  }

  void ctx.destroy().catch(() => {});
  process.exit(0);
}

const ignoreTransportReset = (err: unknown): boolean =>
  String(err).includes('ECONNRESET') || String(err).includes('connection reset');

process.on('uncaughtException', (err) => {
  if (ignoreTransportReset(err)) return;
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  if (ignoreTransportReset(err)) return;
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
