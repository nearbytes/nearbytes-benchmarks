/**
 * Long-lived peer for protocol-bench (chat + files + replay on hub channel).
 * Uses nearbytes-engine (same runtime as CLI / app).
 *
 *   NEARBYTES_PEER_ROLE=alice|bob node dist/scripts/protocol-peer.js
 */
import { writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { createInterface } from 'readline';
import {
  createEngineRuntime,
  openAndWatch,
  attachSyncInboundRefresh,
  type EngineRuntime,
} from 'nearbytes-engine';
import { BENCH_CREDENTIALS } from '../benchmark-credentials.js';
import { makePayload, hrtimeMs } from '../benchmark-lib.js';
import { readBenchMarkers } from './test-markers.js';
import { setupProtocolConfig, type ProtocolRole } from './protocol-peer-config.js';

interface FileSpec {
  readonly name: string;
  readonly bytes: number;
  readonly seed?: number;
}

interface PublishChatCommand {
  readonly cmd: 'publishChat';
  readonly id: number;
  readonly count: number;
  readonly bodyLen: number;
}

interface ExpectChatCommand {
  readonly cmd: 'expectChat';
  readonly id: number;
  readonly count: number;
  readonly timeoutMs: number;
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

interface ReplayCommand {
  readonly cmd: 'replay';
  readonly id: number;
  readonly stale?: boolean;
  readonly chatOnly?: boolean;
}

interface ExitCommand {
  readonly cmd: 'exit';
}

type Command =
  | PublishChatCommand
  | ExpectChatCommand
  | PublishCommand
  | ExpectCommand
  | ReplayCommand
  | ExitCommand;

function roleFromEnv(): ProtocolRole {
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

function peerDirs(role: ProtocolRole): { workDir: string } {
  const base =
    process.env['NEARBYTES_PEER_BASE'] ??
    path.join(os.tmpdir(), 'nearbytes-protocol-peer');
  return { workDir: path.join(base, role) };
}

async function waitForFriendSession(
  log: EngineRuntime['skeleton']['log'],
  timeoutMs: number,
): Promise<number> {
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
  process.stderr.write(`[protocol-peer] ${line}\n`);
}

function chatBody(len: number, seq: number): string {
  const prefix = `bench-chat-${seq}:`;
  if (len <= prefix.length) return prefix.slice(0, len);
  return prefix + 'x'.repeat(len - prefix.length);
}

async function main(): Promise<void> {
  const role = roleFromEnv();
  const friendTimeoutMs = envMs('NEARBYTES_PEER_FRIEND_MS', 15000);
  const { config, configPath } = await setupProtocolConfig(role);
  diag(`role=${role} config=${configPath} pid=${process.pid}`);
  const rt = await createEngineRuntime(config);
  attachSyncInboundRefresh(rt);
  await openAndWatch(rt, BENCH_CREDENTIALS.volume, true);

  const friendMs = await waitForFriendSession(rt.skeleton.log, friendTimeoutMs);
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
      if (cmd.cmd === 'publishChat') {
        const result = await doPublishChat(rt, cmd);
        out({ id: cmd.id, ok: true, ...result });
      } else if (cmd.cmd === 'expectChat') {
        const result = await doExpectChat(rt, cmd);
        out({ id: cmd.id, ok: true, ...result });
      } else if (cmd.cmd === 'publish') {
        const result = await doPublish(rt, cmd);
        out({ id: cmd.id, ok: true, ...result });
      } else if (cmd.cmd === 'expect') {
        const result = await doExpect(rt, cmd);
        out({ id: cmd.id, ok: true, ...result });
      } else if (cmd.cmd === 'replay') {
        const result = await doReplay(rt, cmd);
        out({ id: cmd.id, ok: true, ...result });
      } else {
        out({ id: (cmd as { id?: number }).id ?? 0, ok: false, error: `unknown cmd` });
      }
    } catch (err) {
      out({ id: (cmd as { id?: number }).id ?? 0, ok: false, error: (err as Error).message });
    }
  }

  diag('exiting');
  await rt.destroy().catch((err) => diag(`destroy failed: ${(err as Error).message}`));
  await writeFile(
    path.join(peerDirs(role).workDir, 'peer.json'),
    JSON.stringify({ role, hostname: os.hostname() }, null, 2),
  );
  process.exit(0);
}

async function doPublishChat(
  rt: EngineRuntime,
  cmd: PublishChatCommand,
): Promise<{ published: number; totalWallMs: number; perMessageMs: number[] }> {
  const t0 = Date.now();
  const per: number[] = [];
  const baseTs = Date.now();
  for (let i = 0; i < cmd.count; i++) {
    const t = hrtimeMs();
    await rt.chatService.publish(
      BENCH_CREDENTIALS.volume,
      chatBody(cmd.bodyLen, cmd.id * 10000 + i),
      baseTs + i,
    );
    per.push(hrtimeMs() - t);
  }
  return { published: cmd.count, totalWallMs: Date.now() - t0, perMessageMs: per };
}

async function doExpectChat(
  rt: EngineRuntime,
  cmd: ExpectChatCommand,
): Promise<{ received: number; wallMs: number }> {
  const t0 = Date.now();
  const startMarkers = await readBenchMarkers(rt.skeleton.log);
  const startCount = startMarkers.filter((m) => m.event === 'inbound-stored' && m.fields.kind === 'event').length;
  const deadline = Date.now() + cmd.timeoutMs;
  let received = 0;
  while (received < cmd.count && Date.now() < deadline) {
    const markers = await readBenchMarkers(rt.skeleton.log);
    received = markers.filter((m) => m.event === 'inbound-stored' && m.fields.kind === 'event').length - startCount;
    if (received >= cmd.count) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (received < cmd.count) {
    throw new Error(`chat timeout: got ${received}/${cmd.count} event markers`);
  }
  return { received: cmd.count, wallMs: Date.now() - t0 };
}

async function doPublish(
  rt: EngineRuntime,
  cmd: PublishCommand,
): Promise<{ files: { name: string; bytes: number; publishMs: number }[]; totalWallMs: number }> {
  const t0 = Date.now();
  const items = cmd.files.map((f) => ({ ...f, buf: makePayload(f.bytes, f.seed ?? 0) }));
  const per: { name: string; bytes: number; publishMs: number }[] = [];

  if (cmd.burst) {
    const starts = items.map(() => Date.now());
    await Promise.all(
      items.map(async (it, i) => {
        await rt.fileService.addFile(BENCH_CREDENTIALS.volume, it.name, it.buf);
        per.push({ name: it.name, bytes: it.bytes, publishMs: Date.now() - starts[i] });
      }),
    );
  } else {
    for (const it of items) {
      const t = Date.now();
      await rt.fileService.addFile(BENCH_CREDENTIALS.volume, it.name, it.buf);
      per.push({ name: it.name, bytes: it.bytes, publishMs: Date.now() - t });
    }
  }
  return { files: per, totalWallMs: Date.now() - t0 };
}

async function doExpect(
  rt: EngineRuntime,
  cmd: ExpectCommand,
): Promise<{
  files: { name: string; bytes: number; receivedMs: number }[];
  wallMs: number;
}> {
  const t0 = Date.now();
  const expected = cmd.files.map((f) => ({ ...f }));
  const remaining: typeof expected = [...expected];
  const captured: { bytes: number; receivedMs: number }[] = [];
  const startMarkers = await readBenchMarkers(rt.skeleton.log);
  const startCount = startMarkers.length;
  const deadline = Date.now() + cmd.timeoutMs;
  while (remaining.length > 0 && Date.now() < deadline) {
    const markers = await readBenchMarkers(rt.skeleton.log);
    for (let i = startCount + captured.length; i < markers.length; i++) {
      const m = markers[i];
      if (m.event !== 'bulk-recv-phases') continue;
      const fields = (m.fields ?? {}) as Record<string, unknown>;
      const bytes = Number(fields.bytes ?? 0);
      const idx = remaining.findIndex((e) => Math.abs(bytes - e.bytes) <= e.bytes * 0.05);
      if (idx < 0) continue;
      remaining.splice(idx, 1);
      captured.push({ bytes, receivedMs: Date.now() - t0 });
    }
    if (remaining.length === 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (remaining.length > 0) {
    throw new Error(`file timeout: missing ${remaining.length}/${expected.length}`);
  }
  captured.sort((a, b) => a.receivedMs - b.receivedMs);
  return {
    files: captured.map((c, i) => ({
      name: expected[i].name,
      bytes: c.bytes,
      receivedMs: c.receivedMs,
    })),
    wallMs: Date.now() - t0,
  };
}

async function doReplay(
  rt: EngineRuntime,
  cmd: ReplayCommand,
): Promise<{
  chatReplayMs: number;
  fileReplayMs: number;
  chatCount: number;
  fileCount: number;
  stale: boolean;
  engineChat: boolean;
}> {
  const stale = cmd.stale !== false;
  const chatOnly = cmd.chatOnly === true;
  const secret = BENCH_CREDENTIALS.volume;

  if (stale) {
    await rt.chatService.invalidateTimeline(secret);
  }
  const chatT0 = hrtimeMs();
  const timeline = await rt.chatService.timeline(secret);
  const chatReplayMs = hrtimeMs() - chatT0;

  let fileReplayMs = 0;
  let fileCount = 0;
  if (!chatOnly) {
    if (stale) {
      rt.fileService.markReplayStale(secret);
    }
    const fileT0 = hrtimeMs();
    const replay = await rt.fileService.getReplayContext(secret);
    fileReplayMs = hrtimeMs() - fileT0;
    fileCount = replay.fs.files.size;
  }

  return {
    chatReplayMs,
    fileReplayMs,
    chatCount: timeline.length,
    fileCount,
    stale,
    engineChat: true,
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
