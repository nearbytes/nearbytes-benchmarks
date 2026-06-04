/**
 * Bidirectional friend-sync integration test.
 *
 *   NEARBYTES_TEST_ROLE=alice|bob  node dist/scripts/sync-bidirectional-test.js
 *
 * Fast local defaults (~10s wall with e2e runner): 1 MiB payload, 50ms poll, 8s receive timeout.
 */

import { mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { createCryptoOperations, createSecret, bytesToHex, computeHash } from 'nearbytes-crypto';
import { writeConfig, type NearbytesConfig } from 'nearbytes-skeleton';
import type { Log } from 'nearbytes-log';
import { createProbeRuntime as createContext, openAndWatch } from 'nearbytes-files/probe-runtime';
import { readBenchMarkers, type RunPhaseTiming } from './test-markers.js';

/** Public test identities — do not use in production. */
export const TEST_CREDENTIALS = {
  profileAlice: 'nearbytes-alice:beautiful-document',
  profileBob: 'nearbytes-bob:beautiful-document',
  volume: 'nearbytes-test:beautiful-document',
  fileAlice: 'the-nearbytes-ledger-alice.bin',
  fileBob: 'the-nearbytes-ledger-bob.bin',
} as const;

type Role = 'alice' | 'bob';

function roleFromEnv(): Role {
  const raw = process.env['NEARBYTES_TEST_ROLE']?.toLowerCase();
  if (raw === 'alice' || raw === 'bob') return raw;
  throw new Error('Set NEARBYTES_TEST_ROLE=alice or NEARBYTES_TEST_ROLE=bob');
}

function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function testPayloadBytes(): number {
  return envMs('NEARBYTES_TEST_PAYLOAD_BYTES', 1024 * 1024);
}

export function makeTestPayload(sizeBytes: number, role: Role): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  const seed = role === 'alice' ? 0xa1 : 0xb0;
  for (let i = 0; i < sizeBytes; i++) {
    buf[i] = (i * 17 + seed) & 0xff;
  }
  return buf;
}

async function profilePublicKeyHex(secret: string): Promise<string> {
  const crypto = createCryptoOperations();
  const kp = await crypto.deriveKeys(createSecret(secret));
  return bytesToHex(kp.publicKey);
}

function testDirs(role: Role): { configPath: string; dataDir: string; workDir: string } {
  const base =
    process.env['NEARBYTES_TEST_BASE'] ??
    path.join(os.tmpdir(), 'nearbytes-sync-bidirectional-test');
  const workDir = path.join(base, role);
  return {
    workDir,
    configPath: path.join(workDir, 'config.json'),
    dataDir: path.join(workDir, 'data'),
  };
}

async function setupConfig(role: Role): Promise<{ config: NearbytesConfig; configPath: string }> {
  const { configPath, dataDir, workDir } = testDirs(role);
  const alicePk = await profilePublicKeyHex(TEST_CREDENTIALS.profileAlice);
  const bobPk = await profilePublicKeyHex(TEST_CREDENTIALS.profileBob);

  if (existsSync(workDir)) {
    await rm(workDir, { recursive: true, force: true });
  }
  await mkdir(workDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const profileSecret =
    role === 'alice' ? TEST_CREDENTIALS.profileAlice : TEST_CREDENTIALS.profileBob;
  const friends = role === 'alice' ? [bobPk] : [alicePk];

  const config: NearbytesConfig = {
    dataDir,
    volumes: [],
    friends,
    profiles: [{ name: role, secret: profileSecret }],
    activeProfile: role,
  };

  process.env['NEARBYTES_CONFIG'] = configPath;
  process.env['NEARBYTES_STORAGE_DIR'] = dataDir;
  await writeConfig(config, configPath);

  return { config, configPath };
}

async function listFilenames(ctx: Awaited<ReturnType<typeof createContext>>): Promise<string[]> {
  const files = await ctx.fileService.listFiles(TEST_CREDENTIALS.volume);
  return files.map((f) => f.filename);
}

async function waitForFriendSession(log: Log, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const markers = await readBenchMarkers(log);
    if (markers.some((m) => m.event === 'friend-session-attached')) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`No friend sync session within ${timeoutMs}ms`);
}

async function waitForPeerFile(
  ctx: Awaited<ReturnType<typeof createContext>>,
  peerFile: string,
  expectedBytes: number,
  timeoutMs: number,
): Promise<{ blobHash: string; wallMs: number }> {
  const start = Date.now();
  const pollMs = envMs('NEARBYTES_TEST_POLL_MS', 50);
  while (Date.now() - start < timeoutMs) {
    await openAndWatch(ctx, TEST_CREDENTIALS.volume, true);
    const files = await ctx.fileService.listFiles(TEST_CREDENTIALS.volume);
    const hit = files.find((f) => f.filename === peerFile);
    if (hit !== undefined) {
      const data = await ctx.fileService.getFile(TEST_CREDENTIALS.volume, hit.blobHash);
      if (data.length === expectedBytes) {
        return { blobHash: hit.blobHash, wallMs: Date.now() - start };
      }
    }
    await sleep(pollMs);
  }
  const final = await listFilenames(ctx);
  throw new Error(
    `Timed out waiting for "${peerFile}" (${expectedBytes} B) — have: ${final.join(', ') || '(none)'}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const role = roleFromEnv();
  const payloadBytes = testPayloadBytes();
  const payload = makeTestPayload(payloadBytes, role);
  const payloadHash = await computeHash(payload);

  const peerFile = role === 'alice' ? TEST_CREDENTIALS.fileBob : TEST_CREDENTIALS.fileAlice;
  const ownFile = role === 'alice' ? TEST_CREDENTIALS.fileAlice : TEST_CREDENTIALS.fileBob;

  const peerWaitMs = envMs('NEARBYTES_TEST_PEER_WAIT_MS', 6000);
  const receiveTimeoutMs = envMs('NEARBYTES_TEST_TIMEOUT_MS', 8000);
  const graceMs = envMs('NEARBYTES_TEST_GRACE_MS', 500);
  const warmupMs = envMs('NEARBYTES_TEST_WARMUP_MS', 400);

  const { config, configPath } = await setupConfig(role);
  const wallStart = Date.now();

  console.log(
    `[${role}] payload ${payloadBytes} B (hash ${payloadHash.slice(0, 16)}…) config ${configPath}`,
  );

  const bootEnd = Date.now();
  const ctx = await createContext(config);
  const bootMs = bootEnd - wallStart;
  let phases: RunPhaseTiming | null = null;

  try {
    if (warmupMs > 0) {
      await sleep(warmupMs);
    }

    console.log(`[${role}] waiting for friend sync session (≤${peerWaitMs}ms)…`);
    const friendWaitStart = Date.now();
    await waitForFriendSession(ctx.skeleton.log, peerWaitMs);
    const friendSessionMs = Date.now() - friendWaitStart;

    await openAndWatch(ctx, TEST_CREDENTIALS.volume, true);
    const pubStart = Date.now();
    await ctx.fileService.addFile(TEST_CREDENTIALS.volume, ownFile, payload);
    const publishMs = Date.now() - pubStart;
    console.log(`[${role}] published ${ownFile} in ${publishMs}ms`);

    console.log(`[${role}] waiting for ${peerFile} (≤${receiveTimeoutMs}ms)…`);
    const recv = await waitForPeerFile(ctx, peerFile, payloadBytes, receiveTimeoutMs);
    const peerData = await ctx.fileService.getFile(TEST_CREDENTIALS.volume, recv.blobHash);
    const peerHash = await computeHash(peerData);
    const peerRole: Role = role === 'alice' ? 'bob' : 'alice';
    const expectedPeerHash = await computeHash(makeTestPayload(payloadBytes, peerRole));
    if (peerHash !== expectedPeerHash) {
      throw new Error(
        `Peer file hash mismatch (got ${peerHash.slice(0, 16)}… expected ${expectedPeerHash.slice(0, 16)}…)`,
      );
    }

    const names = await listFilenames(ctx);
    const totalWallMs = Date.now() - wallStart;
    phases = {
      bootMs,
      profilePublishMs: 0,
      discoveryWaitMs: warmupMs,
      friendSessionMs,
      publishMs,
      receiveMs: recv.wallMs,
      graceMs,
      totalWallMs,
    };
    console.log(
      `[${role}] ✓ bidirectional OK in ${totalWallMs}ms — friend ${friendSessionMs}ms, recv ${recv.wallMs}ms, files: ${names.join(', ')}`,
    );

    const markers = await readBenchMarkers(ctx.skeleton.log);
    const resultPath =
      process.env['NEARBYTES_TEST_OUT'] ??
      path.join(testDirs(role).workDir, 'bidirectional-result.json');
    await writeFile(
      resultPath,
      JSON.stringify(
        {
          meta: { role, hostname: os.hostname(), payloadBytes, impl: 'nearbytes-sync-v0-hyperswarm-mdns' },
          phases,
          markers,
        },
        null,
        2,
      ),
    );

    if (graceMs > 0) {
      await sleep(graceMs);
    }
    void ctx.destroy().catch((err) => {
      console.error('[nearbytes-files] ctx.destroy failed:', err);
    });
    process.exit(0);
  } catch (err) {
    void ctx.destroy().catch((err) => {
      console.error('[nearbytes-files] ctx.destroy failed:', err);
    });
    throw err;
  }
}

const ignoreTransportReset = (err: unknown): boolean =>
  String(err).includes('ECONNRESET') || String(err).includes('connection reset');

process.on('uncaughtException', (err) => {
  if (ignoreTransportReset(err)) return;
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  if (ignoreTransportReset(err)) return;
  console.error(err);
  process.exit(1);
});

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
