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
import { createMarkerTail, pollBenchMarkers, readBenchMarkers } from './test-markers.js';
import { setupProtocolConfig, type ProtocolRole } from './protocol-peer-config.js';
import {
  burstParallelEnabled,
  pregenPayloadEnabled,
  publishPipelineEnabled,
  publishPipelineWidth,
} from '../optimization-flags.js';

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
  const { tail } = await createMarkerTail(rt.skeleton.log);
  const deadline = Date.now() + cmd.timeoutMs;
  let received = 0;
  while (received < cmd.count && Date.now() < deadline) {
    const markers = await pollBenchMarkers(rt.skeleton.log, tail);
    for (const m of markers) {
      if (m.event === 'inbound-stored' && m.fields.kind === 'event') received++;
    }
    if (received >= cmd.count) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (received < cmd.count) {
    throw new Error(`chat timeout: got ${received}/${cmd.count} event markers`);
  }
  return { received: cmd.count, wallMs: Date.now() - t0 };
}

function cpuMsDelta(start: NodeJS.CpuUsage): number {
  const d = process.cpuUsage(start);
  return (d.user + d.system) / 1000;
}

function trackRssMax(): { sample(): void; maxBytes(): number } {
  let max = process.memoryUsage().rss;
  return {
    sample() {
      max = Math.max(max, process.memoryUsage().rss);
    },
    maxBytes() {
      return max;
    },
  };
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function addOneFile(
  rt: EngineRuntime,
  name: string,
  buf: Buffer,
  bytes: number,
  mem: ReturnType<typeof trackRssMax>,
): Promise<{ name: string; bytes: number; publishMs: number }> {
  const t = Date.now();
  mem.sample();
  await rt.fileService.addFile(BENCH_CREDENTIALS.volume, name, buf);
  mem.sample();
  return { name, bytes, publishMs: Date.now() - t };
}

async function doPublish(
  rt: EngineRuntime,
  cmd: PublishCommand,
): Promise<{
  files: { name: string; bytes: number; publishMs: number }[];
  totalWallMs: number;
  publishStartedAt: number;
  publishEndedAt: number;
  publishCpuMs: number;
  encodeRssBytesMax: number;
}> {
  const publishStartedAt = Date.now();
  const t0 = publishStartedAt;
  const cpu0 = process.cpuUsage();
  const mem = trackRssMax();
  const specs = cmd.files.map((f) => ({ ...f, buf: null as Buffer | null }));
  if (pregenPayloadEnabled()) {
    for (const s of specs) {
      mem.sample();
      s.buf = makePayload(s.bytes, s.seed ?? 0);
      mem.sample();
    }
  }
  const per: { name: string; bytes: number; publishMs: number }[] = [];
  const runOne = async (f: (typeof specs)[number]) => {
    const buf = f.buf ?? makePayload(f.bytes, f.seed ?? 0);
    return addOneFile(rt, f.name, buf, f.bytes, mem);
  };
  if (cmd.burst && publishPipelineEnabled()) {
    const width = publishPipelineWidth();
    per.push(...await runWithConcurrency(specs, width, runOne));
  } else if (cmd.burst && burstParallelEnabled()) {
    per.push(...await Promise.all(specs.map((s) => runOne(s))));
  } else {
    for (const s of specs) {
      per.push(await runOne(s));
    }
  }
  mem.sample();
  const publishEndedAt = Date.now();
  return {
    files: per,
    totalWallMs: publishEndedAt - t0,
    publishStartedAt,
    publishEndedAt,
    publishCpuMs: cpuMsDelta(cpu0),
    encodeRssBytesMax: mem.maxBytes(),
  };
}

interface RecvPhaseAnchors {
  firstByteAt: number | null;
  lastByteAt: number | null;
  diskDrainDoneAt: number | null;
  hashDoneAt: number | null;
  renameDoneAt: number | null;
}

function recvPhasesFromMarker(fields: Record<string, unknown>): RecvPhaseAnchors {
  const pick = (k: string): number | null => {
    const v = fields[k];
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    firstByteAt: pick('firstByteAt'),
    lastByteAt: pick('lastByteAt'),
    diskDrainDoneAt: pick('diskDrainDoneAt'),
    hashDoneAt: pick('hashDoneAt'),
    renameDoneAt: pick('renameDoneAt'),
  };
}

async function doExpect(
  rt: EngineRuntime,
  cmd: ExpectCommand,
): Promise<{
  files: { name: string; bytes: number; receivedMs: number; phases: RecvPhaseAnchors }[];
  wallMs: number;
  receiveCpuMs: number;
  decodeRssBytesMax: number;
}> {
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  const mem = trackRssMax();
  const expected = cmd.files.map((f) => ({ ...f }));
  const remaining: typeof expected = [...expected];
  const captured: { bytes: number; receivedMs: number; phases: RecvPhaseAnchors }[] = [];
  const { tail } = await createMarkerTail(rt.skeleton.log);
  const consumedMarkers = new Set<number>();
  const deadline = Date.now() + cmd.timeoutMs;
  while (remaining.length > 0 && Date.now() < deadline) {
    mem.sample();
    const markers = await pollBenchMarkers(rt.skeleton.log, tail);
    for (const m of markers) {
      const i = m.index;
      if (consumedMarkers.has(i)) continue;
      if (m.event === 'peer-stalled') {
        const reason = String((m.fields as Record<string, unknown> | undefined)?.reason ?? 'unknown');
        throw new Error(`sync peer-stalled: ${reason}`);
      }
      if (m.event !== 'bulk-recv-phases') continue;
      const fields = (m.fields ?? {}) as Record<string, unknown>;
      const bytes = Number(fields.bytes ?? 0);
      const idx = remaining.findIndex((e) => Math.abs(bytes - e.bytes) <= e.bytes * 0.05);
      if (idx < 0) continue;
      consumedMarkers.add(i);
      remaining.splice(idx, 1);
      captured.push({
        bytes,
        receivedMs: Date.now() - t0,
        phases: recvPhasesFromMarker(fields),
      });
    }
    if (remaining.length === 0) break;
    await new Promise((r) => setTimeout(r, 10));
    mem.sample();
  }
  if (remaining.length > 0) {
    throw new Error(`file timeout: missing ${remaining.length}/${expected.length}`);
  }
  captured.sort((a, b) => a.receivedMs - b.receivedMs);
  mem.sample();
  return {
    files: captured.map((c, i) => ({
      name: expected[i].name,
      bytes: c.bytes,
      receivedMs: c.receivedMs,
      phases: c.phases,
    })),
    wallMs: Date.now() - t0,
    receiveCpuMs: cpuMsDelta(cpu0),
    decodeRssBytesMax: mem.maxBytes(),
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
