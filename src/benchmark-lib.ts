import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCryptoOperations, createSecret, bytesToHex, EventType } from 'nearbytes-crypto';
import type { AppRecordPayload } from 'nearbytes-crypto';
import { createSignedEvent, type Log } from 'nearbytes-log';
import { writeConfig, type NearbytesConfig } from 'nearbytes-skeleton';
import {
  createIdentityRecord,
  serializeIdentityRecord,
  verifyIdentityRecord,
} from 'nearbytes-chat';
import {
  createEngineRuntime as createContext,
  openAndWatch,
  attachSyncInboundRefresh,
  type EngineRuntime as Context,
} from 'nearbytes-engine';
import { BENCH_CREDENTIALS } from './benchmark-credentials.js';

export type BenchRole = 'sender' | 'receiver';

export interface BenchMarker {
  readonly event: string;
  readonly t: number;
  readonly fields: Record<string, string | number | boolean>;
}

/** Wall-clock phases for report tables (per process). */
export interface RunPhaseTiming {
  readonly bootMs: number;
  readonly profilePublishMs: number;
  readonly discoveryWaitMs: number;
  readonly friendSessionMs: number | null;
  readonly publishMs: number | null;
  readonly receiveMs: number | null;
  readonly graceMs: number;
  readonly totalWallMs: number;
}

export function markerOffsetMs(
  markers: readonly BenchMarker[],
  event: string,
  sinceMs: number,
): number | null {
  const hit = markers.find((m) => m.event === event && m.t >= sinceMs);
  return hit !== undefined ? hit.t - sinceMs : null;
}

export interface TrialManifestEntry {
  readonly name: string;
  readonly sizeBytes: number;
  readonly repeat: number;
  readonly publishWallMs: number;
  readonly publishCpuMs: number;
}

export function benchRoleFromEnv(): BenchRole {
  const raw = process.env['NEARBYTES_BENCH_ROLE']?.toLowerCase();
  if (raw === 'sender' || raw === 'alice') return 'sender';
  if (raw === 'receiver' || raw === 'bob') return 'receiver';
  throw new Error('Set NEARBYTES_BENCH_ROLE=sender|receiver (or alice|bob)');
}

export function hrtimeMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export function makePayload(sizeBytes: number, seed: number): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    buf[i] = (i + seed) & 0xff;
  }
  return buf;
}

export async function profilePublicKeyHex(secret: string): Promise<string> {
  const crypto = createCryptoOperations();
  const kp = await crypto.deriveKeys(createSecret(secret));
  return bytesToHex(kp.publicKey);
}

export function benchRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

export function defaultBenchWorkBase(): string {
  return path.join(benchRepoRoot(), '.local', 'bench', 'work');
}

export function benchWorkDir(role: BenchRole): string {
  const base = process.env['NEARBYTES_BENCH_BASE'] ?? defaultBenchWorkBase();
  return path.join(base, role === 'sender' ? 'alice' : 'bob');
}

export async function setupBenchConfig(role: BenchRole): Promise<{
  config: NearbytesConfig;
  configPath: string;
  profileSecret: string;
}> {
  const workDir = benchWorkDir(role);
  const configPath = path.join(workDir, 'config.json');
  const dataDir = path.join(workDir, 'data');
  const alicePk = await profilePublicKeyHex(BENCH_CREDENTIALS.profileAlice);
  const bobPk = await profilePublicKeyHex(BENCH_CREDENTIALS.profileBob);
  const profileSecret =
    role === 'sender' ? BENCH_CREDENTIALS.profileAlice : BENCH_CREDENTIALS.profileBob;
  const friends = role === 'sender' ? [bobPk] : [alicePk];

  const { mkdir, rm } = await import('fs/promises');
  if (existsSync(workDir)) {
    await rm(workDir, { recursive: true, force: true });
  }
  await mkdir(workDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const profileName = role === 'sender' ? 'alice' : 'bob';
  const config: NearbytesConfig = {
    dataDir,
    volumes: [],
    friends,
    profiles: [{ name: profileName, secret: profileSecret }],
    activeProfile: profileName,
  };
  process.env['NEARBYTES_CONFIG'] = configPath;
  process.env['NEARBYTES_STORAGE_DIR'] = dataDir;
  await writeConfig(config, configPath);
  return { config, configPath, profileSecret };
}

export async function publishProfile(
  ctx: Context,
  displayName: string,
  bio: string,
): Promise<{ publicKey: string; eventHash: string; publishMs: number }> {
  if (ctx.config.profiles.length === 0 || ctx.config.activeProfile === null) {
    throw new Error('active profile required');
  }
  const active = ctx.config.profiles.find((p) => p.name === ctx.config.activeProfile);
  if (!active) {
    throw new Error(`active profile "${ctx.config.activeProfile}" missing from profiles[]`);
  }
  const t0 = hrtimeMs();
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(active.secret));
  const publicKey = bytesToHex(keyPair.publicKey);
  const record = await createIdentityRecord(
    ctx.skeleton.crypto,
    keyPair,
    { displayName, bio },
    Date.now(),
  );
  if (!(await verifyIdentityRecord(ctx.skeleton.crypto, record))) {
    throw new Error('profile record verification failed');
  }
  const payload: AppRecordPayload = {
    type: EventType.APP_RECORD,
    protocol: 'nb.identity.record.v1',
    authorPublicKey: publicKey,
    record: serializeIdentityRecord(record),
    publishedAt: Date.now(),
  };
  const signedEvent = await createSignedEvent(ctx.skeleton.crypto, keyPair, payload, []);
  const eventHash = await ctx.skeleton.log.events.storeEvent(keyPair.publicKey, signedEvent);
  const publishMs = hrtimeMs() - t0;
  await ctx.skeleton.log.sync.appendMarker(
    `bench ${JSON.stringify({ bench: 'profile-published', t: Date.now(), displayName, eventHash: eventHash.slice(0, 16) })}`,
  );
  return { publicKey, eventHash, publishMs };
}

export async function readBenchMarkers(log: Log): Promise<BenchMarker[]> {
  const lines = await log.sync.readMarkers();
  const out: BenchMarker[] = [];
  for (const line of lines) {
    if (!line.startsWith('bench ')) continue;
    try {
      const parsed = JSON.parse(line.slice(6)) as {
        bench: string;
        t: number;
        [key: string]: string | number | boolean;
      };
      const { bench: event, t, ...rest } = parsed;
      out.push({ event, t, fields: rest });
    } catch (err) {
      console.warn('[nearbytes-benchmarks] malformed bench marker line:', line.slice(0, 80), err);
    }
  }
  return out;
}

export async function waitForBenchEvent(
  log: Log,
  event: string,
  sinceWallMs: number,
  timeoutMs = 0,
): Promise<BenchMarker> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  let lastBeat = 0;
  for (;;) {
    const markers = await readBenchMarkers(log);
    const hit = markers.find((m) => m.event === event && m.t >= sinceWallMs);
    if (hit) return hit;
    if (Date.now() - lastBeat >= 3000) {
      if (deadline != null) {
        const leftSec = Math.ceil((deadline - Date.now()) / 1000);
        benchProgress('sync', `waiting for ${event} (${leftSec}s left)`);
      } else {
        benchProgress('sync', `waiting for ${event}…`);
      }
      lastBeat = Date.now();
    }
    if (deadline != null && Date.now() >= deadline) {
      throw new Error(`Timed out waiting for bench event "${event}"`);
    }
    await sleep(200);
  }
}

export async function readReceptionTail(
  dataDir: string,
  limit = 40,
): Promise<string[]> {
  const filePath = path.join(dataDir, 'sync', 'reception.jsonl');
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, 'utf-8');
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.slice(-limit);
}

export async function readActivityRaw(dataDir: string): Promise<string[]> {
  const filePath = path.join(dataDir, 'sync', 'activity.log');
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, 'utf-8');
  return text.trim().split('\n').filter(Boolean);
}

export interface BenchActivityEvent {
  readonly bench: string;
  readonly t: number;
  readonly kind?: string;
  readonly bytes?: number;
  readonly name?: string;
  readonly streamIndex?: number;
  readonly firstByteAt?: number;
  readonly lastByteAt?: number;
  readonly diskDrainDoneAt?: number;
  readonly hashDoneAt?: number;
  readonly renameDoneAt?: number;
}

export function parseBenchActivityLines(activityLog: readonly string[]): BenchActivityEvent[] {
  const events: BenchActivityEvent[] = [];
  for (const line of activityLog) {
    if (!line.startsWith('bench ')) continue;
    try {
      events.push(JSON.parse(line.slice(6)) as BenchActivityEvent);
    } catch (err) {
      console.warn('[nearbytes-benchmarks] malformed activity line:', line.slice(0, 80), err);
    }
  }
  return events.sort((a, b) => a.t - b.t);
}

/** Min block size for counting inbound bytes (sync chunks are often < 1 MiB). */
export function minInboundBlockBytes(_nominalBytes: number): number {
  return 4096;
}

/** Goodput from first-to-last inbound-stored block between throughput phase markers. */
export function inboundStreamProgress(
  receiverLog: readonly string[],
  sinceWallMs: number,
  minBlockBytes: number,
): { readonly bytes: number; readonly chunks: number } {
  const blocks = parseBenchActivityLines(receiverLog).filter(
    (e) =>
      e.bench === 'inbound-stored' &&
      e.kind === 'block' &&
      e.t >= sinceWallMs &&
      Number(e.bytes) >= minBlockBytes,
  );
  const bytes = blocks.reduce((s, b) => s + (Number(b.bytes) || 0), 0);
  return { bytes, chunks: blocks.length };
}

export function formatBenchBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

/** Wire throughput from receiver `bulk-recv-phases` marker (first→last byte). */
export function wireFromBulkRecvPhases(
  receiverLog: readonly string[],
  sinceWallMs: number,
  minBlockBytes: number,
): {
  readonly bytes: number;
  readonly wireMs: number;
  readonly diskDrainMs: number;
  readonly hashMs: number;
  readonly renameMs: number;
  readonly markerAt: number;
} | null {
  const events = parseBenchActivityLines(receiverLog);
  const candidate = events.find(
    (e) =>
      e.bench === 'bulk-recv-phases' &&
      e.t >= sinceWallMs &&
      Number(e.bytes) >= minBlockBytes &&
      typeof e.firstByteAt === 'number' &&
      typeof e.lastByteAt === 'number',
  );
  if (!candidate) return null;
  const first = candidate.firstByteAt!;
  const last = candidate.lastByteAt!;
  const diskDrain = candidate.diskDrainDoneAt ?? last;
  const hashDone = candidate.hashDoneAt ?? diskDrain;
  const renameDone = candidate.renameDoneAt ?? hashDone;
  return {
    bytes: Number(candidate.bytes) || 0,
    wireMs: Math.max(0, last - first),
    diskDrainMs: Math.max(0, diskDrain - last),
    hashMs: Math.max(0, hashDone - diskDrain),
    renameMs: Math.max(0, renameDone - hashDone),
    markerAt: candidate.t,
  };
}

export function goodputFromInboundMarkers(
  receiverLog: readonly string[],
  nominalBytes: number,
  senderLog: readonly string[] = [],
  sinceWallMs?: number,
  streamIndex?: number,
): {
  readonly goodputMbps: number;
  readonly durationMs: number;
  readonly bytesReceived: number;
} | null {
  const phaseEvents = parseBenchActivityLines(senderLog.length > 0 ? senderLog : receiverLog);
  const starts = phaseEvents.filter((e) => e.bench === 'throughput-phase-start');
  const ends = phaseEvents.filter((e) => e.bench === 'throughput-phase-end');
  const start =
    streamIndex !== undefined
      ? starts.find((e) => e.streamIndex === streamIndex)
      : starts[starts.length - 1];
  const end =
    streamIndex !== undefined
      ? ends.find((e) => e.streamIndex === streamIndex)
      : ends[ends.length - 1];
  const t0 = start?.t ?? sinceWallMs;
  if (t0 === undefined) return null;
  const tEnd = end?.t;
  const minBlockBytes = minInboundBlockBytes(nominalBytes);
  const events = parseBenchActivityLines(receiverLog);
  const blocks = events.filter(
    (e) =>
      e.bench === 'inbound-stored' &&
      e.kind === 'block' &&
      e.t >= t0 &&
      (tEnd === undefined || e.t <= tEnd + 500) &&
      Number(e.bytes) >= minBlockBytes,
  );
  if (blocks.length === 0) return null;
  const first = blocks[0]!.t;
  const last = blocks[blocks.length - 1]!.t;
  const durationMs =
    blocks.length === 1 ? Math.max(1, last - t0) : Math.max(1, last - first);
  const bytesReceived = blocks.reduce((s, b) => s + (Number(b.bytes) || 0), 0);
  const effective =
    nominalBytes > 0 ? Math.min(nominalBytes, bytesReceived) : bytesReceived;
  return {
    goodputMbps: (effective * 8) / (durationMs * 1000),
    durationMs,
    bytesReceived,
  };
}

export const BENCH_SYNC_PROBE = 'bench-sync-probe.bin';
export const BENCH_SYNC_PROBE_ACK = 'bench-sync-probe-ack.txt';

export function latencyTrialFilename(sizeBytes: number, repeat: number): string {
  return `bench-lat-${sizeBytes}-${repeat}.bin`;
}

export function latencyRecvAckFilename(sizeBytes: number, repeat: number): string {
  return `bench-lat-recv-ack-${sizeBytes}-${repeat}.txt`;
}

export function blockMatchesPayload(blockBytes: number, sizeBytes: number): boolean {
  return blockBytes >= sizeBytes && blockBytes <= sizeBytes + 512;
}

export function buildLatencyTrialOrder(
  payloadSizes: readonly number[],
  repeats: number,
): { readonly name: string; readonly sizeBytes: number; readonly repeat: number }[] {
  const order: { name: string; sizeBytes: number; repeat: number }[] = [];
  for (const sizeBytes of payloadSizes) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      order.push({
        name: latencyTrialFilename(sizeBytes, repeat),
        sizeBytes,
        repeat,
      });
    }
  }
  return order;
}

export async function writeLatencyRecvAck(
  ctx: Context,
  sizeBytes: number,
  repeat: number,
): Promise<void> {
  await ctx.fileService.addFile(
    BENCH_CREDENTIALS.volume,
    latencyRecvAckFilename(sizeBytes, repeat),
    Buffer.from(`ok ${sizeBytes} ${repeat}\n`),
  );
}

export async function listBenchFilenames(ctx: Context): Promise<string[]> {
  const files = await ctx.fileService.listFiles(BENCH_CREDENTIALS.volume);
  return files.map((f) => f.path).filter((n) => n.startsWith('bench-'));
}

/** Wait until a bench volume file appears. timeoutMs 0 = event-driven (no wall-clock limit). */
export async function waitForBenchFilename(
  ctx: Context,
  filename: string,
  timeoutMs = 0,
  role = 'sender',
): Promise<{ wallMs: number; cpuMs: number }> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  let lastBeat = 0;
  for (;;) {
    await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);
    const names = await listBenchFilenames(ctx);
    if (names.includes(filename)) {
      return { wallMs: Date.now(), cpuMs: hrtimeMs() };
    }
    if (Date.now() - lastBeat >= 5000) {
      if (deadline != null) {
        const leftSec = Math.ceil((deadline - Date.now()) / 1000);
        benchProgress(role, `waiting for ${filename} — ${leftSec}s left`);
      } else {
        benchProgress(role, `waiting for ${filename}…`);
      }
      lastBeat = Date.now();
    }
    if (deadline != null && Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${filename}`);
    }
    await sleep(100);
  }
}

/** Sender: publish probe and wait for receiver ack (proves volume sync path). */
export async function runSenderSyncProbe(
  ctx: Context,
  timeoutMs: number,
): Promise<void> {
  benchProgress('sender', 'sync probe — publish');
  const t = Date.now();
  await ctx.fileService.addFile(
    BENCH_CREDENTIALS.volume,
    BENCH_SYNC_PROBE,
    makePayload(4096, 0xa5),
  );
  await ctx.skeleton.log.sync.appendMarker(
    `bench ${JSON.stringify({ bench: 'file-published', name: BENCH_SYNC_PROBE, sizeBytes: 4096, t })}`,
  );
  await waitForBenchFilename(ctx, BENCH_SYNC_PROBE_ACK, timeoutMs);
  benchProgress('sender', 'sync probe — ack received');
}

async function ensureSyncProbeAck(ctx: Context, names: readonly string[]): Promise<void> {
  if (!names.includes(BENCH_SYNC_PROBE_ACK)) {
    await ctx.fileService.addFile(
      BENCH_CREDENTIALS.volume,
      BENCH_SYNC_PROBE_ACK,
      Buffer.from('sync ok\n'),
    );
  }
}

/** Receiver: wait for probe file in listFiles, then ack (no size-only inbound guess). */
export async function runReceiverSyncProbe(ctx: Context, timeoutMs: number): Promise<void> {
  benchProgress('receiver', 'sync probe — waiting');
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  let lastBeat = 0;
  for (;;) {
    await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);
    const names = await listBenchFilenames(ctx);
    if (names.includes(BENCH_SYNC_PROBE)) {
      await ensureSyncProbeAck(ctx, names);
      benchProgress('receiver', 'sync probe — ack sent');
      return;
    }
    const latencyStarted = names.some(
      (n) =>
        (n.startsWith('bench-lat-') || n.startsWith('bench-lat-warm-')) && n.endsWith('.bin'),
    );
    if (latencyStarted) {
      await ensureSyncProbeAck(ctx, names);
      benchProgress('receiver', 'sync probe — ok (latency traffic visible)');
      return;
    }
    if (Date.now() - lastBeat >= 5000) {
      benchProgress('receiver', 'sync probe — waiting…');
      lastBeat = Date.now();
    }
    if (deadline != null && Date.now() >= deadline) {
      throw new Error(`Timed out waiting for sync probe (${timeoutMs}ms)`);
    }
    await sleep(50);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sleep with periodic heartbeats so long waits never look stuck. */
export async function sleepWithProgress(
  role: string,
  label: string,
  ms: number,
  tickMs = 3000,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const leftSec = Math.max(1, Math.ceil((end - Date.now()) / 1000));
    benchProgress(role, `${label} — ${leftSec}s remaining`);
    await sleep(Math.min(tickMs, end - Date.now()));
  }
}

let progressOriginMs = Date.now();

export function resetProgressClock(): void {
  progressOriginMs = Date.now();
}

/** Line-buffered progress for long benchmark runs (visible in CI and remote SSH). */
export function benchProgress(role: string, message: string): void {
  const elapsed = ((Date.now() - progressOriginMs) / 1000).toFixed(1);
  process.stdout.write(`[bench ${role} +${elapsed}s] ${message}\n`);
}

export async function createBenchContext(config: NearbytesConfig): Promise<Context> {
  const rt = await createContext(config);
  attachSyncInboundRefresh(rt);
  return rt;
}
