/**
 * Shared protocol benchmark suite (selectable: chat-sync, chat-replay, file).
 */
import { mkdir, writeFile, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  workload,
  CHAT_BODY_LEN,
  FILE_CHUNK_MIB,
  chunkBytes,
  aggregateBytes,
  fileTimeoutMs,
  chatTimeoutMs,
} from './sizes.mjs';
import { parseProtocolMatrix } from './matrix.mjs';
import { TestDb, trialSlug } from './record.mjs';
import { quantiles, studentCi95 } from './stats.mjs';

function fmtMs(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function countTrials(W, matrix) {
  let n = 1; // session
  if (matrix.replayOnly) {
    n += 1; // seed publish
    const replayTargets = W.replayMidChat.length > 0 ? W.replayMidChat.length : 1;
    n += replayTargets + 1; // mid replay checkpoints + final
    return n;
  }
  if (matrix.chatSync) {
    if (W.chatWarmup > 0) n += 1;
    n += W.chatTargets.filter((target) => target > W.chatWarmup).length;
  }
  if (matrix.chatReplay) {
    n += W.chatTargets.filter((t) => W.replayMidChat.includes(t)).length;
    n += 1; // final replay
  }
  if (matrix.file) {
    n += W.fileBursts.length * (W.fileWarmup + W.fileMeasured);
  }
  return n;
}

export async function runProtocolSuite({
  category,
  repoRoot,
  outDir,
  summaryLink,
  machines,
  extraMeta = {},
  startPair,
}) {
  const matrix = parseProtocolMatrix();
  const W = workload();
  const db = new TestDb(outDir);
  const t0 = Date.now();
  db.setTotal(countTrials(W, matrix));

  await db.init({
    category,
    smoke: process.env.NEARBYTES_PROTOCOL_SMOKE === '1',
    workload: W,
    matrix: matrix.raw,
    fileChunkMiB: FILE_CHUNK_MIB,
    chatBodyLen: CHAT_BODY_LEN,
    machines,
    ...extraMeta,
  });

  db.status(`protocol ${category} matrix=${matrix.raw} → ${outDir}`);

  const chatBatches = [];
  const replayCheckpoints = [];
  const fileTrials = [];
  const chatOnlyReplay = !matrix.file;

  const pair = await startPair();
  await db.recordTrial(
    trialSlug(['session', 'friend']),
    {
      phase: 'session',
      friendSessionMs: pair.friendMs,
      matrix: matrix.raw,
      ok: true,
    },
    { log: `alice=${pair.friendMs?.alice}ms bob=${pair.friendMs?.bob}ms` },
  );
  db.progress(`pair ready (alice ${pair.friendMs.alice}ms, bob ${pair.friendMs.bob}ms)`);

  const replayOpts = { stale: true, chatOnly: chatOnlyReplay };

  try {
    if (matrix.replayOnly) {
      const seedN = W.replayMidChat.length > 0 ? Math.max(...W.replayMidChat) : 100;
      const slug = trialSlug(['chat', 'seed', `n${String(seedN).padStart(4, '0')}`]);
      try {
        const r = await pair.publishChatBatch(seedN, CHAT_BODY_LEN, chatTimeoutMs(category));
        await db.recordTrial(slug, { phase: 'chat', kind: 'seed', ...r, ok: true });
        db.progress(`chat seed n=${seedN} ok`);
      } catch (err) {
        await db.recordTrial(slug, { phase: 'chat', kind: 'seed', error: err.message, ok: false });
        db.progress(`chat seed FAIL`);
      }
      const replayTargets = W.replayMidChat.length > 0 ? W.replayMidChat : [seedN];
      for (const target of replayTargets) {
        const rslug = trialSlug(['replay', 'after-chat', `n${String(target).padStart(4, '0')}`]);
        try {
          const rep = await pair.replay({
            ...replayOpts,
            timeoutMs: chatTimeoutMs(category),
          });
          replayCheckpoints.push({ label: `after-chat-${target}`, ...rep });
          await db.recordTrial(rslug, { phase: 'replay', label: `after-chat-${target}`, ...rep, ok: true }, {
            log: `chat=${fmtMs(rep.chatReplayMs)} (${rep.chatCount}) engine=${rep.engineChat}`,
          });
          db.progress(`replay @${target} ok chat=${fmtMs(rep.chatReplayMs)}`);
        } catch (err) {
          await db.recordTrial(rslug, { phase: 'replay', error: err.message, ok: false });
          db.progress(`replay @${target} FAIL`);
        }
      }
      const fslug = trialSlug(['replay', 'final']);
      try {
        const finalReplay = await pair.replay({
          ...replayOpts,
          timeoutMs: chatTimeoutMs(category),
        });
        replayCheckpoints.push({ label: 'final', ...finalReplay });
        await db.recordTrial(fslug, { phase: 'replay', label: 'final', ...finalReplay, ok: true });
        db.progress(`final replay ok chat=${fmtMs(finalReplay.chatReplayMs)}`);
      } catch (err) {
        await db.recordTrial(fslug, { phase: 'replay', label: 'final', error: err.message, ok: false });
        db.progress(`final replay FAIL`);
      }
    } else {
      if (matrix.chatSync && W.chatWarmup > 0) {
        const slug = trialSlug(['chat', 'warmup', `n${String(W.chatWarmup).padStart(4, '0')}`]);
        try {
          const r = await pair.publishChatBatch(W.chatWarmup, CHAT_BODY_LEN, chatTimeoutMs(category));
          await db.recordTrial(slug, { phase: 'chat', kind: 'warmup', ...r, ok: true });
          db.progress(`chat warmup n=${W.chatWarmup} ok`);
        } catch (err) {
          await db.recordTrial(slug, { phase: 'chat', kind: 'warmup', error: err.message, ok: false });
          db.progress(`chat warmup FAIL`);
        }
      }

      if (matrix.chatSync) {
        for (const target of W.chatTargets) {
          const slug = trialSlug(['chat', 'target', `n${String(target).padStart(4, '0')}`]);
          try {
            const r = await pair.publishChatBatch(target, CHAT_BODY_LEN, chatTimeoutMs(category));
            if (!r.skipped) {
              const row = {
                targetCount: target,
                delta: r.delta,
                wallMs: r.wallMs,
                amortizedMs: r.amortizedMs,
                publishWallMs: r.publishWallMs,
              };
              chatBatches.push(row);
              await db.recordTrial(slug, { phase: 'chat', ...row, ok: true }, {
                log: `Δ=${r.delta} wall=${fmtMs(r.wallMs)} amort=${fmtMs(r.amortizedMs)}/msg`,
              });
              db.progress(`chat n=${target} ok ${fmtMs(r.wallMs)} (${fmtMs(r.amortizedMs)}/msg)`);
            }
          } catch (err) {
            chatBatches.push({ targetCount: target, error: err.message });
            await db.recordTrial(slug, { phase: 'chat', targetCount: target, error: err.message, ok: false });
            db.progress(`chat n=${target} FAIL`);
          }

          if (matrix.chatReplay && W.replayMidChat.includes(target)) {
            const rslug = trialSlug(['replay', 'after-chat', `n${String(target).padStart(4, '0')}`]);
            try {
              const rep = await pair.replay({
                ...replayOpts,
                timeoutMs: fileTimeoutMs(category, W.fileBursts.at(-1)?.count ?? 16),
              });
              replayCheckpoints.push({ label: `after-chat-${target}`, ...rep });
              await db.recordTrial(rslug, { phase: 'replay', label: `after-chat-${target}`, ...rep, ok: true }, {
                log: `chat=${fmtMs(rep.chatReplayMs)} (${rep.chatCount}) files=${fmtMs(rep.fileReplayMs)}`,
              });
              db.progress(`replay @${target} ok`);
            } catch (err) {
              await db.recordTrial(rslug, { phase: 'replay', error: err.message, ok: false });
              db.progress(`replay @${target} FAIL`);
            }
          }
        }
      }

      if (matrix.file) {
        for (const burst of W.fileBursts) {
          const bytes = chunkBytes();
          const agg = aggregateBytes(burst.count);
          const runs = [];
          const reps = W.fileWarmup + W.fileMeasured;
          const timeout = fileTimeoutMs(category, burst.count);

          for (let rep = 0; rep < reps; rep++) {
            const isWarmup = rep < W.fileWarmup;
            const repTag = isWarmup ? 'warmup' : `rep${String(rep - W.fileWarmup + 1).padStart(2, '0')}`;
            const slug = trialSlug([
              'file',
              `${FILE_CHUNK_MIB}mib`,
              `x${String(burst.count).padStart(2, '0')}`,
              burst.mode,
              repTag,
            ]);
            try {
              const files = Array.from({ length: burst.count }, () => ({ bytes }));
              const useBurst = burst.mode === 'burst' && burst.count > 1;
              const m = await pair.measureFiles({ files, timeoutMs: timeout, burst: useBurst });
              const row = {
                ...m,
                chunkMiB: FILE_CHUNK_MIB,
                mode: burst.mode,
                aggregateMiB: (agg / (1024 * 1024)).toFixed(0),
                warmup: isWarmup,
              };
              if (!isWarmup) runs.push(m);
              await db.recordTrial(slug, { phase: 'file', ...row, ok: true }, {
                log: `${FILE_CHUNK_MIB}×${burst.count} ${burst.mode} ${repTag}: ${fmtMs(m.wallMs)} ${m.goodputMbps} Mb/s`,
              });
              db.progress(
                `file ${FILE_CHUNK_MIB}×${burst.count} ${burst.mode} ${repTag} ok ${fmtMs(m.wallMs)} ${m.goodputMbps} Mb/s`,
              );
            } catch (err) {
              await db.recordTrial(slug, {
                phase: 'file',
                chunkMiB: FILE_CHUNK_MIB,
                count: burst.count,
                mode: burst.mode,
                warmup: isWarmup,
                error: err.message,
                ok: false,
              });
              db.progress(`file ${FILE_CHUNK_MIB}×${burst.count} ${burst.mode} ${repTag} FAIL`);
            }
          }

          fileTrials.push({
            chunkMiB: FILE_CHUNK_MIB,
            sizeBytes: bytes,
            count: burst.count,
            mode: burst.mode,
            aggregateBytes: agg,
            aggregateMiB: agg / (1024 * 1024),
            runs,
            wallMs: quantiles(runs.map((r) => r.wallMs)),
            goodputMbps: quantiles(runs.map((r) => r.goodputMbps)),
            ci95Mbps: studentCi95(runs.map((r) => r.goodputMbps), { min: 0 }),
          });
        }
      }

      if (matrix.chatReplay) {
        const fslug = trialSlug(['replay', 'final']);
        try {
          const finalReplay = await pair.replay({
            ...replayOpts,
            timeoutMs: fileTimeoutMs(category, W.fileBursts.at(-1)?.count ?? 16),
          });
          replayCheckpoints.push({ label: 'final', ...finalReplay });
          await db.recordTrial(fslug, { phase: 'replay', label: 'final', ...finalReplay, ok: true }, {
            log: `chat=${fmtMs(finalReplay.chatReplayMs)} files=${fmtMs(finalReplay.fileReplayMs)}`,
          });
          db.progress(`final replay ok`);
        } catch (err) {
          await db.recordTrial(fslug, { phase: 'replay', label: 'final', error: err.message, ok: false });
          db.progress(`final replay FAIL`);
        }
      }
    }
  } finally {
    await pair.stop();
  }

  const summary = {
    schemaVersion: 2,
    category,
    runDir: outDir,
    generatedAt: new Date().toISOString(),
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    smoke: process.env.NEARBYTES_PROTOCOL_SMOKE === '1',
    matrix: matrix.raw,
    machines,
    friendSessionMs: pair.friendMs,
    workload: W,
    fileChunkMiB: FILE_CHUNK_MIB,
    chatBodyLen: CHAT_BODY_LEN,
    chatBatches,
    fileTrials,
    replayCheckpoints,
    runtime: 'nearbytes-engine',
    ...extraMeta,
  };

  await db.writeSummary(summary);
  await db.writeManifest({
    category,
    wallSeconds: summary.wallSeconds,
    matrix: matrix.raw,
    summaryPath: join(outDir, 'summary.json'),
  });
  await db.logLine(`done ${summary.wallSeconds}s → summary.json`);

  if (summaryLink) {
    await mkdir(dirname(summaryLink), { recursive: true });
    await writeFile(summaryLink, JSON.stringify(summary, null, 2));
    await cp(join(outDir, 'manifest.json'), join(dirname(summaryLink), `${category}-manifest.json`));
  }

  db.status(`done ${summary.wallSeconds}s → summary.json`);
  return summary;
}
