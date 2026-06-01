/**
 * Long-lived peer for the network-bench harness.
 *
 *   NEARBYTES_PEER_ROLE=alice|bob node dist/scripts/network-peer.js
 *
 * Unlike `sync-bidirectional-test`, this binary stays alive across many
 * publish/expect cycles. The orchestrator drives both peers over stdin
 * with newline-delimited JSON commands:
 *
 *   alice: {cmd:"publish", id, files:[{name,bytes,seed}], burst?:bool}
 *   bob:   {cmd:"expect",  id, files:[{name,bytes}], timeoutMs}
 *   both:  {cmd:"exit"}
 *
 * Each non-exit command is acknowledged on stdout with a single line of
 * JSON: {id, ok:true, ...} or {id, ok:false, error}. Diagnostic logs go
 * to stderr so stdout stays a clean command channel.
 *
 * Peer boot cost (config, log, sync handshake) is paid once. Subsequent
 * publishes/expects each cost only the actual data path, so a category
 * sweep of N×{small,large,burst} measurements finishes in ~1 minute on
 * loopback instead of ~6 minutes with per-measurement spawns.
 */
import { mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { createInterface } from 'readline';
import { createCryptoOperations, createSecret, bytesToHex } from 'nearbytes-crypto';
import { writeConfig, type NearbytesConfig } from 'nearbytes-skeleton';
import type { Log } from 'nearbytes-log';
import { createContext, openAndWatch } from 'nearbytes-files/cli/context';
import { makePayload } from '../benchmark-lib.js';
import { readBenchMarkers } from './test-markers.js';

const TEST_CREDENTIALS = {
  profileAlice: 'nearbytes-alice:beautiful-document',
  profileBob: 'nearbytes-bob:beautiful-document',
  volume: 'nearbytes-net:beautiful-document',
} as const;

type Role = 'alice' | 'bob';

interface FileSpec {
  readonly name: string;
  readonly bytes: number;
  readonly seed?: number;
}

interface PublishCommand {
  readonly cmd: 'publish';
  readonly id: number;
  readonly files: readonly FileSpec[];
  readonly burst?: boolean;
}

interface ExpectCommand {
  readonly cmd: 'expect';
  readonly id: number;
  readonly files: readonly FileSpec[];
  readonly timeoutMs: number;
}

interface ExitCommand {
  readonly cmd: 'exit';
}

type Command = PublishCommand | ExpectCommand | ExitCommand;

function roleFromEnv(): Role {
  const raw = process.env['NEARBYTES_PEER_ROLE']?.toLowerCase();
  if (raw === 'alice' || raw === 'bob') return raw;
  throw new Error('Set NEARBYTES_PEER_ROLE=alice|bob');
}

function envMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function profilePublicKey(secret: string): Promise<string> {
  const crypto = createCryptoOperations();
  const kp = await crypto.deriveKeys(createSecret(secret));
  return bytesToHex(kp.publicKey);
}

function peerDirs(role: Role): { configPath: string; dataDir: string; workDir: string } {
  const base =
    process.env['NEARBYTES_PEER_BASE'] ??
    path.join(os.tmpdir(), 'nearbytes-network-peer');
  const workDir = path.join(base, role);
  return {
    workDir,
    configPath: path.join(workDir, 'config.json'),
    dataDir: path.join(workDir, 'data'),
  };
}

async function setupConfig(role: Role): Promise<{ config: NearbytesConfig; configPath: string }> {
  const { configPath, dataDir, workDir } = peerDirs(role);
  const alicePk = await profilePublicKey(TEST_CREDENTIALS.profileAlice);
  const bobPk = await profilePublicKey(TEST_CREDENTIALS.profileBob);
  if (existsSync(workDir)) {
    await rm(workDir, { recursive: true, force: true });
  }
  await mkdir(workDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const profileSecret = role === 'alice' ? TEST_CREDENTIALS.profileAlice : TEST_CREDENTIALS.profileBob;
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

async function waitForFriendSession(log: Log, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const markers = await readBenchMarkers(log);
    if (markers.some((m) => m.event === 'friend-session-attached')) {
      return Date.now() - start;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`No friend-session-attached within ${timeoutMs}ms`);
}

function out(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function diag(line: string): void {
  process.stderr.write(`[peer] ${line}\n`);
}

async function main(): Promise<void> {
  const role = roleFromEnv();
  const friendTimeoutMs = envMs('NEARBYTES_PEER_FRIEND_MS', 15000);
  const { config, configPath } = await setupConfig(role);
  diag(`role=${role} config=${configPath} pid=${process.pid}`);
  const ctx = await createContext(config);

  // Open and start watching the shared volume; this primes the channel
  // and keeps the receiver's poll loop attached for inbound files.
  await openAndWatch(ctx, TEST_CREDENTIALS.volume, true);

  const friendMs = await waitForFriendSession(ctx.skeleton.log, friendTimeoutMs);
  diag(`friend session attached in ${friendMs}ms`);
  out({ event: 'ready', role, friendSessionMs: friendMs, pid: process.pid });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim();
    if (text === '') continue;
    let cmd: Command;
    try {
      cmd = JSON.parse(text);
    } catch (err) {
      out({ ok: false, error: `bad JSON: ${(err as Error).message}` });
      continue;
    }
    if (cmd.cmd === 'exit') break;
    try {
      if (cmd.cmd === 'publish') {
        const result = await doPublish(ctx, cmd);
        out({ id: cmd.id, ok: true, ...result });
      } else if (cmd.cmd === 'expect') {
        const result = await doExpect(ctx, cmd);
        out({ id: cmd.id, ok: true, ...result });
      } else {
        out({ id: (cmd as { id?: number }).id ?? 0, ok: false, error: `unknown cmd ${JSON.stringify(cmd)}` });
      }
    } catch (err) {
      out({ id: (cmd as { id?: number }).id ?? 0, ok: false, error: (err as Error).message });
    }
  }

  diag('exiting');
  await ctx.destroy().catch((err) => diag(`destroy failed: ${(err as Error).message}`));
  await writeFile(
    path.join(peerDirs(role).workDir, 'peer.json'),
    JSON.stringify({ role, hostname: os.hostname() }, null, 2),
  );
  process.exit(0);
}

async function doPublish(
  ctx: Awaited<ReturnType<typeof createContext>>,
  cmd: PublishCommand,
): Promise<{ files: { name: string; bytes: number; publishMs: number }[]; totalWallMs: number }> {
  const t0 = Date.now();
  const items = cmd.files.map((f) => ({ ...f, buf: makePayload(f.bytes, f.seed ?? 0) }));
  const per: { name: string; bytes: number; publishMs: number }[] = [];

  if (cmd.burst) {
    const starts = items.map(() => Date.now());
    await Promise.all(
      items.map(async (it, i) => {
        await ctx.fileService.addFile(TEST_CREDENTIALS.volume, it.name, it.buf);
        per.push({ name: it.name, bytes: it.bytes, publishMs: Date.now() - starts[i] });
      }),
    );
  } else {
    for (const it of items) {
      const t = Date.now();
      await ctx.fileService.addFile(TEST_CREDENTIALS.volume, it.name, it.buf);
      per.push({ name: it.name, bytes: it.bytes, publishMs: Date.now() - t });
    }
  }
  return { files: per, totalWallMs: Date.now() - t0 };
}

async function doExpect(
  ctx: Awaited<ReturnType<typeof createContext>>,
  cmd: ExpectCommand,
): Promise<{
  files: { name: string; bytes: number; receivedMs: number }[];
  wallMs: number;
  bulkRecvMarkers: unknown[];
}> {
  // Take a "watermark" of the activity log before publish so we ignore any
  // markers from previous measurements. We watch the markers stream
  // directly — `bulk-recv-phases` fires the moment the receiver finishes
  // writing+hashing+renaming a block — and match by (bytes ± 5%) and
  // chronological order. This is O(1) per check; no per-volume listFiles
  // scan, so timings stay flat as the volume grows across the sweep.
  const t0 = Date.now();
  const expected = cmd.files.map((f) => ({ ...f }));
  const remaining: typeof expected = [...expected];
  const captured: { bytes: number; receivedMs: number; fields: Record<string, unknown> }[] = [];
  const startMarkers = await readBenchMarkers(ctx.skeleton.log);
  const startCount = startMarkers.length;
  const deadline = Date.now() + cmd.timeoutMs;
  while (remaining.length > 0 && Date.now() < deadline) {
    const markers = await readBenchMarkers(ctx.skeleton.log);
    for (let i = startCount + captured.length; i < markers.length; i++) {
      const m = markers[i];
      if (m.event !== 'bulk-recv-phases') continue;
      const fields = (m.fields ?? {}) as Record<string, unknown>;
      const bytes = Number(fields.bytes ?? 0);
      // Pick the first still-pending expected file whose size matches.
      const idx = remaining.findIndex((e) => Math.abs(bytes - e.bytes) <= e.bytes * 0.05);
      if (idx < 0) continue;
      remaining.splice(idx, 1);
      captured.push({ bytes, receivedMs: Date.now() - t0, fields });
    }
    if (remaining.length === 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (remaining.length > 0) {
    throw new Error(
      `timeout: missing ${remaining.length}/${expected.length} files ` +
        `(have ${captured.length} bulk-recv-phases markers)`,
    );
  }
  // Sort captured by receivedMs so per-file timing reflects arrival order.
  captured.sort((a, b) => a.receivedMs - b.receivedMs);
  return {
    files: captured.map((c, i) => ({
      name: expected[i].name,
      bytes: c.bytes,
      receivedMs: c.receivedMs,
    })),
    wallMs: Date.now() - t0,
    bulkRecvMarkers: captured.map((c) => ({ event: 'bulk-recv-phases', t: c.receivedMs, fields: c.fields })),
  };
}

process.on('uncaughtException', (err) => {
  diag(`UNCAUGHT: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
});
process.on('unhandledRejection', (err) => {
  diag(`UNHANDLED: ${String(err)}`);
  process.exit(2);
});

main().catch((err) => {
  diag(`fatal: ${String(err)}`);
  process.exit(1);
});
