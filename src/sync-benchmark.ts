/**
 * Research-grade friend-sync benchmark (Impl.~0: Hyperswarm + mDNS, global delta).
 *
 *   NEARBYTES_BENCH_ROLE=sender|receiver  node dist/scripts/sync-benchmark.js
 *
 * Writes JSON to NEARBYTES_BENCH_OUT or <workDir>/benchmark-result.json
 */

import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { BENCH_CREDENTIALS } from './benchmark-credentials.js';
import {
  effectiveStreamSizes,
  getBenchProfile,
  type BenchProfile,
} from './benchmark-config.js';
import {
  benchRoleFromEnv,
  benchWorkDir,
  createBenchContext,
  formatBenchBytes,
  goodputFromInboundMarkers,
  hrtimeMs,
  inboundStreamProgress,
  minInboundBlockBytes,
  listBenchFilenames,
  makePayload,
  publishProfile,
  readActivityRaw,
  readBenchMarkers,
  readReceptionTail,
  setupBenchConfig,
  sleep,
  sleepWithProgress,
  benchProgress,
  resetProgressClock,
  waitForBenchEvent,
  waitForBenchFilename,
  runSenderSyncProbe,
  runReceiverSyncProbe,
  buildLatencyTrialOrder,
  blockMatchesPayload,
  latencyTrialFilename,
  latencyRecvAckFilename,
  writeLatencyRecvAck,
  parseBenchActivityLines,
  wireFromBulkRecvPhases,
  type BenchMarker,
  type TrialManifestEntry,
} from './benchmark-lib.js';
import { openAndWatch } from 'nearbytes-files/cli/context';

interface StreamThroughputResult {
  readonly streamIndex: number;
  readonly sizeBytes: number;
  readonly name: string;
  readonly publishWallMs?: number;
  readonly publishCpuMs?: number;
  readonly publishWallCpuMs?: number;
  readonly goodputMbps?: number;
  readonly inboundDurationMs?: number;
  readonly bytesReceived?: number;
  /** Wire throughput from receiver bulk-recv-phases marker (first→last byte). */
  readonly wireMbps?: number;
  readonly wireDurationMs?: number;
  readonly diskDrainDurationMs?: number;
  readonly hashDurationMs?: number;
  readonly renameDurationMs?: number;
}

interface LatencyResult {
  readonly sizeBytes: number;
  readonly repeat: number;
  readonly name: string;
  readonly publishWallMs?: number;
  readonly publishCpuMs?: number;
  readonly receiveWallMs?: number;
  readonly receiveCpuMs?: number;
}

interface BenchmarkResult {
  readonly meta: {
    readonly role: string;
    readonly hostname: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly impl: 'nearbytes-sync-v0-hyperswarm-mdns';
    readonly quick: boolean;
    readonly mode: string;
  };
  readonly warmup: {
    readonly discoveryWaitMs: number;
    readonly swarmFormationMs: number | null;
    readonly profilePublishMs: number;
    readonly profileEventHash: string;
    readonly profilePublicKey: string;
  };
  readonly latency: readonly LatencyResult[];
  readonly throughput: {
    readonly mode: 'batch' | 'stream' | 'none';
    readonly streams: readonly StreamThroughputResult[];
  } | null;
  readonly markers: readonly BenchMarker[];
  readonly receptionTail: readonly string[];
  readonly activityLog: readonly string[];
  readonly phases: {
    readonly bootMs: number;
    readonly profilePublishMs: number;
    readonly discoveryWaitMs: number;
    readonly friendSessionMs: number | null;
    readonly publishMs: number | null;
    readonly receiveMs: number | null;
    readonly graceMs: number;
    readonly totalWallMs: number;
  };
}

async function runLatencyWarmup(
  ctx: Awaited<ReturnType<typeof createBenchContext>>,
  profile: BenchProfile,
): Promise<void> {
  if (profile.latencyWarmupRepeats <= 0) return;
  const sizeBytes = profile.payloadSizes[0] ?? 4096;
  benchProgress(
    'sender',
    `latency warmup (${profile.latencyWarmupRepeats}×${sizeBytes} B, discarded)`,
  );
  for (let repeat = 0; repeat < profile.latencyWarmupRepeats; repeat++) {
    const name = `bench-lat-warm-${sizeBytes}-${repeat}.bin`;
    await ctx.fileService.addFile(
      BENCH_CREDENTIALS.volume,
      name,
      makePayload(sizeBytes, repeat + 0x7a),
    );
    if (profile.interTrialMs > 0) {
      await sleep(profile.interTrialMs);
    }
  }
}

async function runSender(
  ctx: Awaited<ReturnType<typeof createBenchContext>>,
  profile: BenchProfile,
): Promise<{
  latency: LatencyResult[];
  throughput: BenchmarkResult['throughput'];
  trials: TrialManifestEntry[];
}> {
  const latency: LatencyResult[] = [];
  const trials: TrialManifestEntry[] = [];
  const totalTrials = profile.payloadSizes.length * profile.latencyRepeats;
  let trialIdx = 0;

  if (profile.coordinatedTrials) {
    await runSenderSyncProbe(ctx, profile.syncReadyTimeoutMs);
  }

  await runLatencyWarmup(ctx, profile);

  benchProgress('sender', `phase 3/4 — latency sweep (${totalTrials} payloads)`);
  for (const sizeBytes of profile.payloadSizes) {
    for (let repeat = 0; repeat < profile.latencyRepeats; repeat++) {
      trialIdx++;
      const name = latencyTrialFilename(sizeBytes, repeat);
      const t0 = hrtimeMs();
      const publishWallMs = Date.now();
      const data = makePayload(sizeBytes, repeat + sizeBytes);
      await ctx.fileService.addFile(BENCH_CREDENTIALS.volume, name, data);
      const publishCpuMs = hrtimeMs() - t0;
      await ctx.skeleton.log.sync.appendMarker(
        `bench ${JSON.stringify({ bench: 'file-published', name, sizeBytes, t: publishWallMs })}`,
      );
      trials.push({ name, sizeBytes, repeat, publishWallMs, publishCpuMs });
      latency.push({ sizeBytes, repeat, name, publishWallMs, publishCpuMs });
      benchProgress(
        'sender',
        `latency ${trialIdx}/${totalTrials}: ${name} (${sizeBytes} B, cpu ${publishCpuMs.toFixed(1)}ms)`,
      );
      if (profile.coordinatedTrials) {
        await waitForBenchFilename(
          ctx,
          latencyRecvAckFilename(sizeBytes, repeat),
          profile.trialAckTimeoutMs,
          'sender',
        );
      } else if (profile.interTrialMs > 0) {
        await sleepWithProgress(
          'sender',
          `inter-trial pause before ${trialIdx + 1}/${totalTrials}`,
          profile.interTrialMs,
          Math.min(1000, profile.interTrialMs),
        );
      }
    }
  }

  await ctx.fileService.addFile(
    BENCH_CREDENTIALS.volume,
    'bench-phase-latency-complete.txt',
    Buffer.from('latency phase complete\n'),
  );
  benchProgress('sender', 'latency phase complete');

  if (profile.throughputMode === 'none') {
    return { latency, throughput: null, trials };
  }

  const preTpPause = profile.quick ? 500 : profile.mode === 'paper' ? 1000 : 5000;
  await sleepWithProgress('sender', 'pause before throughput phase', preTpPause, 500);

  if (profile.throughputMode === 'stream') {
    const sizes = effectiveStreamSizes(profile);
    const streams: StreamThroughputResult[] = [];
    benchProgress('sender', `phase 4/4 — goodput sweep (${sizes.length} stream sizes)`);
    for (let si = 0; si < sizes.length; si++) {
      const streamBytes = sizes[si]!;
      const name = `bench-tp-stream-${streamBytes}.bin`;
      if (si > 0 && profile.streamInterPauseMs > 0) {
        await sleepWithProgress(
          'sender',
          `pause before stream ${si + 1}/${sizes.length}`,
          profile.streamInterPauseMs,
          500,
        );
      }
      const publishStartMs = hrtimeMs();
      const publishStartWallMs = Date.now();
      benchProgress(
        'sender',
        `stream ${si + 1}/${sizes.length}: publishing ${formatBenchBytes(streamBytes)}…`,
      );
      await ctx.fileService.addFile(
        BENCH_CREDENTIALS.volume,
        name,
        makePayload(streamBytes, 0x5154 + si),
      );
      const publishEndWallMs = Date.now();
      const publishEndMs = hrtimeMs();
      await ctx.skeleton.log.sync.appendMarker(
        `bench ${JSON.stringify({ bench: 'file-published', name, sizeBytes: streamBytes, t: publishEndWallMs })}`,
      );
      const phaseStartWall = publishStartWallMs;
      await ctx.skeleton.log.sync.appendMarker(
        `bench ${JSON.stringify({ bench: 'throughput-phase-start', bytes: streamBytes, streamIndex: si, t: phaseStartWall })}`,
      );
      streams.push({
        streamIndex: si,
        sizeBytes: streamBytes,
        name,
        publishWallMs: publishStartWallMs,
        publishCpuMs: publishEndMs - publishStartMs,
        publishWallCpuMs: publishEndWallMs - publishStartWallMs,
      });
      benchProgress(
        'sender',
        `stream ${si + 1}/${sizes.length}: published in ${(publishEndMs - publishStartMs).toFixed(0)}ms cpu`,
      );
      const ackName = `bench-tp-stream-${streamBytes}-recv-ack.txt`;
      if (profile.coordinatedTrials) {
        await waitForBenchFilename(
          ctx,
          ackName,
          profile.throughputReceiveTimeoutMs,
          'sender',
        );
        benchProgress('sender', `stream ${si + 1}/${sizes.length}: receiver ack`);
      }
      const phaseEndWall = Date.now();
      await ctx.skeleton.log.sync.appendMarker(
        `bench ${JSON.stringify({ bench: 'throughput-phase-end', bytes: streamBytes, streamIndex: si, t: phaseEndWall })}`,
      );
    }
    await ctx.fileService.addFile(
      BENCH_CREDENTIALS.volume,
      'bench-phase-throughput-complete.txt',
      Buffer.from('throughput phase complete\n'),
    );
    return {
      latency,
      throughput: { mode: 'stream', streams },
      trials,
    };
  }

  const tpCount = profile.throughputFileCount;
  const tpBytes = profile.throughputFileBytes;
  benchProgress('sender', `phase 4/4 — throughput batch ${tpCount}×${tpBytes} B`);
  const publishStartWallMs = Date.now();
  await ctx.skeleton.log.sync.appendMarker(
    `bench ${JSON.stringify({ bench: 'throughput-phase-start', bytes: tpBytes * tpCount, t: publishStartWallMs })}`,
  );
  const publishStartMs = hrtimeMs();
  for (let i = 0; i < tpCount; i++) {
    const name = `bench-tp-${tpBytes}-${i}.bin`;
    await ctx.fileService.addFile(
      BENCH_CREDENTIALS.volume,
      name,
      makePayload(tpBytes, i * 997),
    );
    benchProgress('sender', `throughput file ${i + 1}/${tpCount}: ${name}`);
  }
  const publishEndMs = hrtimeMs();
  const publishEndWallMs = Date.now();
  await ctx.skeleton.log.sync.appendMarker(
    `bench ${JSON.stringify({ bench: 'throughput-phase-end', bytes: tpBytes * tpCount, t: publishEndWallMs })}`,
  );
  await ctx.fileService.addFile(
    BENCH_CREDENTIALS.volume,
    'bench-phase-throughput-complete.txt',
    Buffer.from('throughput phase complete\n'),
  );
  benchProgress(
    'sender',
    `throughput published ${tpCount}×${tpBytes} B in ${(publishEndMs - publishStartMs).toFixed(0)}ms`,
  );

  return {
    latency,
    throughput: {
      mode: 'batch',
      streams: [
        {
          streamIndex: 0,
          sizeBytes: tpBytes,
          name: `bench-tp-batch-${tpBytes}`,
          publishWallMs: publishStartWallMs,
          publishCpuMs: publishEndMs - publishStartMs,
        },
      ],
    },
    trials,
  };
}

async function runReceiver(
  ctx: Awaited<ReturnType<typeof createBenchContext>>,
  profile: BenchProfile,
  expectedLatencyTrials: number,
): Promise<{
  latency: LatencyResult[];
  throughput: BenchmarkResult['throughput'];
}> {
  const receivedAt = new Map<string, { wallMs: number; cpuMs: number }>();
  const latency: LatencyResult[] = [];

  if (profile.coordinatedTrials) {
    await runReceiverSyncProbe(ctx, profile.syncReadyTimeoutMs);
  }

  const trialOrder = buildLatencyTrialOrder(profile.payloadSizes, profile.latencyRepeats);
  let nextTrialIdx = 0;
  let inboundCursor = 0;

  const latencyDeadline =
    profile.latencyReceiveTimeoutMs > 0
      ? Date.now() + profile.latencyReceiveTimeoutMs
      : null;
  const waitSenderLatencyDone =
    profile.coordinatedTrials && profile.latencyReceiveTimeoutMs <= 0;
  benchProgress('receiver', `phase 3/4 — waiting for ${expectedLatencyTrials} latency payloads…`);

  let lastBeat = Date.now();
  for (;;) {
    await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);
    const names = await listBenchFilenames(ctx);
    for (const name of names) {
      if (!name.startsWith('bench-') || receivedAt.has(name)) continue;
      if (name.startsWith('bench-lat-') && name.endsWith('.bin')) {
        receivedAt.set(name, { wallMs: Date.now(), cpuMs: hrtimeMs() });
        const trial = trialOrder.find((t) => t.name === name);
        if (trial && profile.coordinatedTrials) {
          const ack = latencyRecvAckFilename(trial.sizeBytes, trial.repeat);
          if (!names.includes(ack)) {
            await writeLatencyRecvAck(ctx, trial.sizeBytes, trial.repeat);
          }
        }
      } else if (
        name === 'bench-phase-latency-complete.txt' ||
        name === 'bench-phase-throughput-complete.txt'
      ) {
        receivedAt.set(name, { wallMs: Date.now(), cpuMs: hrtimeMs() });
      }
    }

    if (profile.coordinatedTrials && nextTrialIdx < trialOrder.length) {
      const events = parseBenchActivityLines(await readActivityRaw(ctx.config.dataDir));
      const blocks = events.filter(
        (e) => e.bench === 'inbound-stored' && e.kind === 'block',
      );
      while (nextTrialIdx < trialOrder.length && inboundCursor < blocks.length) {
        const trial = trialOrder[nextTrialIdx]!;
        const block = blocks[inboundCursor]!;
        inboundCursor++;
        if (!blockMatchesPayload(Number(block.bytes), trial.sizeBytes)) {
          continue;
        }
        if (!receivedAt.has(trial.name)) {
          receivedAt.set(trial.name, { wallMs: block.t, cpuMs: hrtimeMs() });
          const ack = latencyRecvAckFilename(trial.sizeBytes, trial.repeat);
          if (!names.includes(ack)) {
            await writeLatencyRecvAck(ctx, trial.sizeBytes, trial.repeat);
          }
        }
        nextTrialIdx++;
      }
    }

    if (Date.now() - lastBeat >= 2000) {
      const latSeen = trialOrder.filter((t) => receivedAt.has(t.name)).length;
      if (latencyDeadline != null) {
        const leftSec = Math.ceil((latencyDeadline - Date.now()) / 1000);
        benchProgress(
          'receiver',
          `latency wait… ${latSeen}/${expectedLatencyTrials} payloads, ${leftSec}s left`,
        );
      } else {
        benchProgress(
          'receiver',
          `latency wait… ${latSeen}/${expectedLatencyTrials} payloads`,
        );
      }
      lastBeat = Date.now();
    }

    const allLatencySeen = trialOrder.every((t) => receivedAt.has(t.name));
    const senderStartedThroughput = names.some(
      (n) => n.startsWith('bench-tp-stream-') && n.endsWith('.bin'),
    );
    if (
      waitSenderLatencyDone &&
      (receivedAt.has('bench-phase-latency-complete.txt') ||
        allLatencySeen ||
        senderStartedThroughput)
    ) {
      break;
    }
    if (
      !waitSenderLatencyDone &&
      (receivedAt.has('bench-phase-latency-complete.txt') ||
        (profile.latencyOnly && allLatencySeen) ||
        allLatencySeen)
    ) {
      break;
    }
    if (latencyDeadline != null && Date.now() >= latencyDeadline) {
      break;
    }
    await sleep(profile.receiverPollMs);
  }

  for (const trial of trialOrder) {
    const recv = receivedAt.get(trial.name);
    latency.push({
      sizeBytes: trial.sizeBytes,
      repeat: trial.repeat,
      name: trial.name,
      receiveWallMs: recv?.wallMs,
      receiveCpuMs: recv?.cpuMs,
    });
  }

  const latSeen = latency.filter((l) => l.receiveWallMs !== undefined).length;
  benchProgress('receiver', `latency complete: ${latSeen}/${expectedLatencyTrials} payloads`);
  if (profile.coordinatedTrials && latSeen < expectedLatencyTrials) {
    const senderDone = receivedAt.has('bench-phase-latency-complete.txt');
    throw new Error(
      `Latency phase incomplete: ${latSeen}/${expectedLatencyTrials} (sender phase marker=${senderDone ? 'yes' : 'no'})`,
    );
  }

  if (profile.throughputMode === 'none') {
    return { latency, throughput: null };
  }

  const streamSizes =
    profile.throughputMode === 'stream'
      ? [...effectiveStreamSizes(profile)]
      : [];
  const streams: StreamThroughputResult[] = [];

  if (profile.throughputMode === 'stream') {
    benchProgress(
      'receiver',
      `phase 4/4 — goodput sweep (${streamSizes.length} sizes, inbound + listFiles)…`,
    );
    for (let si = 0; si < streamSizes.length; si++) {
      const streamBytes = streamSizes[si]!;
      const name = `bench-tp-stream-${streamBytes}.bin`;
      const legDeadline =
        profile.throughputReceiveTimeoutMs > 0
          ? Date.now() + profile.throughputReceiveTimeoutMs
          : null;
      let legStart = Date.now();
      lastBeat = Date.now();
      let legDone = false;

      const minBlockBytes = minInboundBlockBytes(streamBytes);
      let wire: ReturnType<typeof wireFromBulkRecvPhases> = null;

      while (!legDone) {
        await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);
        const names = await listBenchFilenames(ctx);
        if (names.includes(name) && !receivedAt.has(name)) {
          receivedAt.set(name, { wallMs: Date.now(), cpuMs: hrtimeMs() });
        }
        const activityLog = await readActivityRaw(ctx.config.dataDir);
        wire = wireFromBulkRecvPhases(activityLog, legStart, minBlockBytes);
        const inbound = inboundStreamProgress(activityLog, legStart, minBlockBytes);
        const hasFile = receivedAt.has(name);

        if (Date.now() - lastBeat >= 5000) {
          if (legDeadline != null) {
            const leftSec = Math.ceil((legDeadline - Date.now()) / 1000);
            benchProgress(
              'receiver',
              `stream ${si + 1}/${streamSizes.length} (${formatBenchBytes(streamBytes)}): inbound ${formatBenchBytes(inbound.bytes)}, listFiles=${hasFile ? 'yes' : 'no'}, ${leftSec}s left`,
            );
          } else {
            benchProgress(
              'receiver',
              `stream ${si + 1}/${streamSizes.length} (${formatBenchBytes(streamBytes)}): inbound ${formatBenchBytes(inbound.bytes)}, listFiles=${hasFile ? 'yes' : 'no'}`,
            );
          }
          lastBeat = Date.now();
        }

        if (wire !== null && wire.bytes >= streamBytes * 0.95) {
          legDone = true;
          break;
        }
        if (inbound.bytes >= streamBytes * 0.95 || hasFile) {
          legDone = true;
        }
        if (!legDone && legDeadline != null && Date.now() >= legDeadline) {
          break;
        }
        if (!legDone && names.includes('bench-phase-throughput-complete.txt')) {
          throw new Error(
            `Stream ${name} incomplete but sender finished throughput phase (inbound ${inbound.bytes}/${streamBytes} B)`,
          );
        }
        await sleep(profile.receiverPollMs);
      }

      const activityLog = await readActivityRaw(ctx.config.dataDir);
      if (wire === null) {
        wire = wireFromBulkRecvPhases(activityLog, legStart, minBlockBytes);
      }
      const inboundFinal = inboundStreamProgress(activityLog, legStart, minBlockBytes);
      const hasFileFinal = receivedAt.has(name);
      if (!legDone) {
        throw new Error(
          `Stream ${name} incomplete: inbound ${inboundFinal.bytes}/${streamBytes} B, listFiles=${hasFileFinal}`,
        );
      }

      const g = goodputFromInboundMarkers(activityLog, streamBytes, [], legStart, si);
      const wireMbps =
        wire && wire.wireMs > 0 ? (wire.bytes * 8) / wire.wireMs / 1000 : undefined;
      streams.push({
        streamIndex: si,
        sizeBytes: streamBytes,
        name,
        goodputMbps: g?.goodputMbps,
        inboundDurationMs: g?.durationMs,
        bytesReceived: g?.bytesReceived,
        ...(wireMbps !== undefined ? { wireMbps } : {}),
        ...(wire ? { wireDurationMs: wire.wireMs } : {}),
        ...(wire ? { diskDrainDurationMs: wire.diskDrainMs } : {}),
        ...(wire ? { hashDurationMs: wire.hashMs } : {}),
        ...(wire ? { renameDurationMs: wire.renameMs } : {}),
      });
      if (wireMbps !== undefined && wire) {
        const drainTail = wire.diskDrainMs > 0 ? `, drain ${wire.diskDrainMs}ms` : '';
        const hashTail = wire.hashMs > 0 ? `, hash ${wire.hashMs}ms` : '';
        benchProgress(
          'receiver',
          `stream ${si + 1} done — wire ${wireMbps.toFixed(0)} Mb/s (${wire.wireMs}ms${drainTail}${hashTail}), ${formatBenchBytes(streamBytes)}`,
        );
      } else if (g !== null) {
        benchProgress(
          'receiver',
          `stream ${si + 1} done — ${g.goodputMbps.toFixed(1)} Mb/s, ${formatBenchBytes(streamBytes)}`,
        );
      }
      await ctx.fileService.addFile(
        BENCH_CREDENTIALS.volume,
        `bench-tp-stream-${streamBytes}-recv-ack.txt`,
        Buffer.from(`stream ${si} complete\n`),
      );
    }

    await waitForBenchFilename(
      ctx,
      'bench-phase-throughput-complete.txt',
      profile.throughputReceiveTimeoutMs,
      'receiver',
    );
    receivedAt.set('bench-phase-throughput-complete.txt', {
      wallMs: Date.now(),
      cpuMs: hrtimeMs(),
    });
  } else {
    benchProgress('receiver', 'phase 4/4 — waiting for throughput batch…');
    const tpDeadline = Date.now() + profile.throughputReceiveTimeoutMs;
    while (Date.now() < tpDeadline) {
      await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);
      const names = await listBenchFilenames(ctx);
      for (const n of names) {
        if (!receivedAt.has(n)) receivedAt.set(n, { wallMs: Date.now(), cpuMs: hrtimeMs() });
      }
      if (receivedAt.has('bench-phase-throughput-complete.txt')) break;
      await sleep(profile.receiverPollMs);
    }
    streams.push({
      streamIndex: 0,
      sizeBytes: profile.throughputFileBytes * profile.throughputFileCount,
      name: 'bench-tp-batch',
    });
  }

  return {
    latency,
    throughput: { mode: profile.throughputMode, streams },
  };
}

async function main(): Promise<void> {
  const profile = getBenchProfile();
  const role = benchRoleFromEnv();
  const roleLabel = role === 'sender' ? 'sender' : 'receiver';
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  const runStartMs = hrtimeMs();
  resetProgressClock();
  benchProgress(
    roleLabel,
    profile.mode === 'paper'
      ? `phase 1/4 — setup (PAPER: ${profile.latencyRepeats}×${profile.payloadSizes.length} latency, ${effectiveStreamSizes(profile).length} stream sizes)`
      : profile.latencyOnly
        ? `phase 1/4 — setup (LATENCY-ONLY, ${profile.payloadSizes.length} payloads, no throughput)`
        : profile.quick
          ? 'phase 1/4 — setup (QUICK profile, target ≤30s)'
          : 'phase 1/4 — setup config and start sync',
  );

  const { config } = await setupBenchConfig(role);
  const bootEnd = Date.now();
  const ctx = await createBenchContext(config);
  const bootMs = bootEnd - wallStart;

  let swarmFormationMs: number | null = null;
  let publishPhaseMs: number | null = null;
  let receivePhaseMs: number | null = null;
  let profilePublishMs = 0;
  let profileEventHash = '';
  let profilePublicKey = '';

  try {
    const displayName =
      role === 'sender' ? BENCH_CREDENTIALS.displayAlice : BENCH_CREDENTIALS.displayBob;
    const bio =
      role === 'sender'
        ? 'NearBytes benchmark sender (profile channel)'
        : 'NearBytes benchmark receiver (profile channel)';

    const published = await publishProfile(ctx, displayName, bio);
    profilePublishMs = published.publishMs;
    profileEventHash = published.eventHash;
    profilePublicKey = published.publicKey;
    benchProgress(roleLabel, `profile published (${profilePublishMs.toFixed(1)}ms cpu)`);

    benchProgress(roleLabel, 'phase 2/4 — discovery / swarm warmup');
    await sleepWithProgress(
      roleLabel,
      'discovery / swarm warmup',
      profile.discoveryMs,
    );
    await openAndWatch(ctx, BENCH_CREDENTIALS.volume, true);

    try {
      const peerMarker = await waitForBenchEvent(
        ctx.skeleton.log,
        'friend-session-attached',
        wallStart,
        profile.swarmTimeoutMs,
      );
      swarmFormationMs = peerMarker.t - wallStart;
      benchProgress(
        roleLabel,
        `swarm connected +${swarmFormationMs}ms (transport=${peerMarker.fields['transport']})`,
      );
    } catch (err) {
      benchProgress(roleLabel, `swarm not observed: ${String(err)}`);
    }

    if (profile.coordinatedTrials && swarmFormationMs === null) {
      throw new Error('Paper benchmark requires friend-session-attached before trials');
    }

    const expectedLatency = profile.payloadSizes.length * profile.latencyRepeats;
    const transferStart = Date.now();
    const senderLatency =
      role === 'sender'
        ? await runSender(ctx, profile)
        : { latency: [], throughput: null, trials: [] };
    const receiverLatency =
      role === 'receiver'
        ? await runReceiver(ctx, profile, expectedLatency)
        : { latency: [], throughput: null };
    const transferEnd = Date.now();
    if (role === 'sender') {
      publishPhaseMs = transferEnd - transferStart;
    } else {
      receivePhaseMs = transferEnd - transferStart;
    }

    await sleepWithProgress(
      roleLabel,
      'grace hold for peer pull before teardown',
      profile.graceMs,
      profile.quick ? 1000 : 5000,
    );

    const markers = await readBenchMarkers(ctx.skeleton.log);
    const receptionTail = await readReceptionTail(config.dataDir, 50);
    const activityLog = await readActivityRaw(config.dataDir);

    const result: BenchmarkResult = {
      meta: {
        role,
        hostname: os.hostname(),
        startedAt,
        finishedAt: new Date().toISOString(),
        impl: 'nearbytes-sync-v0-hyperswarm-mdns',
        quick: profile.quick,
        mode: profile.mode,
      },
      warmup: {
        discoveryWaitMs: profile.discoveryMs,
        swarmFormationMs,
        profilePublishMs,
        profileEventHash,
        profilePublicKey,
      },
      latency: role === 'sender' ? senderLatency.latency : receiverLatency.latency,
      throughput:
        role === 'sender' ? senderLatency.throughput : receiverLatency.throughput,
      markers,
      receptionTail,
      activityLog,
      phases: {
        bootMs,
        profilePublishMs,
        discoveryWaitMs: profile.discoveryMs,
        friendSessionMs: swarmFormationMs,
        publishMs: role === 'sender' ? publishPhaseMs : null,
        receiveMs: role === 'receiver' ? receivePhaseMs : null,
        graceMs: profile.graceMs,
        totalWallMs: Date.now() - wallStart,
      },
    };

    const outPath =
      process.env['NEARBYTES_BENCH_OUT'] ??
      path.join(benchWorkDir(role), 'benchmark-result.json');
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(result, null, 2), 'utf-8');
    benchProgress(roleLabel, `done — wrote ${outPath} (total ${(hrtimeMs() - runStartMs).toFixed(0)}ms cpu)`);

    if (role === 'sender') {
      const trialPath = path.join(benchWorkDir(role), 'trial-manifest.json');
      await writeFile(trialPath, JSON.stringify(senderLatency.trials, null, 2));
    }

    void ctx.destroy().catch((err) => {
      console.error('[nearbytes-benchmarks] ctx.destroy failed:', err);
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
  process.exit(0);
}

process.on('uncaughtException', (err) => {
  console.error('[nearbytes-benchmarks] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[nearbytes-benchmarks] unhandledRejection:', err);
  process.exit(1);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
