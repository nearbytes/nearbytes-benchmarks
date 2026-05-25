/**
 * Cross-platform resource monitor.
 *
 * Samples a target process tree (the head PID + every direct child) at a
 * fixed cadence and returns per-sample CPU%, RSS, and a delta of bytes
 * written to disk over the whole sampling window. CPU% is computed from
 * cumulative kernel+user ticks, so wall-clock samples can be turned into
 * pct = (ticks(t) - ticks(t-1)) / clk_tck / dt.
 *
 * Platforms:
 *   Linux  — /proc/<pid>/stat (utime, stime, rss), /proc/diskstats for
 *            system-wide disk-write deltas.
 *   macOS  — `ps -p <pid> -o pcpu,rss` (pcpu is already a %, sampled from
 *            kernel by ps), `iostat -d -w 1 1` for disk MB/s. macOS doesn't
 *            expose a stable per-process disk-write counter, so we fall
 *            back to a system-wide `iostat` delta.
 *
 * Output (always):
 *   {
 *     samplingMs: number,
 *     samples: Array<{ tMs, cpuPctMean, rssBytesMax, rssBytesMean }>,
 *     diskWriteBytes: number | null,   // total bytes written during the window
 *     diskMaxMBps:    number | null,
 *   }
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';

const exec = promisify(execFile);

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function readProcStat(pid) {
  try {
    const txt = await readFile(`/proc/${pid}/stat`, 'utf8');
    // The 2nd field can contain spaces inside parens: "comm". Skip past it.
    const close = txt.lastIndexOf(')');
    const tail = txt.slice(close + 2).split(/\s+/);
    // After comm (skipped): state utime[11] stime[12] ... rss[21] (0-indexed in tail: 11=utime, 12=stime, 21=rss in pages)
    const utime = Number(tail[11]);
    const stime = Number(tail[12]);
    const rssPages = Number(tail[21]);
    return { utime, stime, rssPages };
  } catch {
    return null;
  }
}

async function readProcChildren(pid) {
  try {
    const txt = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return txt.trim().split(/\s+/).map(Number).filter(Number.isFinite);
  } catch {
    return [];
  }
}

async function readDiskstatsTotal() {
  // Sum sectors written across all non-loop, non-ram block devices, ×512.
  try {
    const txt = await readFile('/proc/diskstats', 'utf8');
    let totalSectors = 0;
    for (const line of txt.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 11) continue;
      const name = f[2];
      if (name.startsWith('loop') || name.startsWith('ram') || /\d$/.test(name)) continue;
      // Field 9 = sectors written (kernel-doc: Documentation/iostats.txt)
      totalSectors += Number(f[9]) || 0;
    }
    return totalSectors * 512;
  } catch {
    return null;
  }
}

/**
 * Linux sampler — exact, cheap, runs in-process.
 */
async function sampleLinux(rootPid, intervalMs, stopRef, samples) {
  const clkTck = 100; // POSIX: getconf CLK_TCK on Linux is 100 in 99%+ configs.
  const pageSize = 4096;
  let prev = new Map();

  const tick = async () => {
    const tMs = nowMs();
    const pids = new Set([rootPid, ...(await readProcChildren(rootPid))]);
    const cur = new Map();
    let cpuTicks = 0;
    let rssBytes = 0;
    let rssMax = 0;
    let count = 0;
    for (const pid of pids) {
      const s = await readProcStat(pid);
      if (!s) continue;
      cur.set(pid, s.utime + s.stime);
      const prevT = prev.get(pid) ?? s.utime + s.stime;
      cpuTicks += Math.max(0, s.utime + s.stime - prevT);
      const r = s.rssPages * pageSize;
      rssBytes += r;
      if (r > rssMax) rssMax = r;
      count++;
    }
    prev = cur;
    const cpuPct = count > 0 ? (cpuTicks / clkTck) / (intervalMs / 1000) * 100 : 0;
    samples.push({
      tMs,
      cpuPctMean: Number(cpuPct.toFixed(2)),
      rssBytesMax: rssMax,
      rssBytesMean: count > 0 ? Math.round(rssBytes / count) : 0,
    });
  };

  await tick(); // seed prev
  while (!stopRef.stopped) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (stopRef.stopped) break;
    await tick();
  }
}

/**
 * macOS sampler — spawns `ps` once per sample. Slower, but reasonably accurate
 * for the few-second windows we measure. Disk I/O is collected as a system-wide
 * delta via `iostat` because macOS has no stable per-pid disk counter.
 */
async function sampleDarwin(rootPid, intervalMs, stopRef, samples) {
  while (!stopRef.stopped) {
    const tMs = nowMs();
    try {
      const { stdout } = await exec('ps', ['-p', String(rootPid), '-o', 'pcpu=,rss=,pid=', '-M']);
      let cpuSum = 0;
      let rssMaxKb = 0;
      let rssSumKb = 0;
      let count = 0;
      for (const line of stdout.trim().split('\n')) {
        const m = line.trim().split(/\s+/);
        if (m.length < 3) continue;
        const pcpu = Number(m[0]);
        const rss = Number(m[1]);
        if (!Number.isFinite(pcpu) || !Number.isFinite(rss)) continue;
        cpuSum += pcpu;
        rssSumKb += rss;
        if (rss > rssMaxKb) rssMaxKb = rss;
        count++;
      }
      samples.push({
        tMs,
        cpuPctMean: Number(cpuSum.toFixed(2)),
        rssBytesMax: rssMaxKb * 1024,
        rssBytesMean: count > 0 ? Math.round((rssSumKb / count) * 1024) : 0,
      });
    } catch {
      samples.push({ tMs, cpuPctMean: 0, rssBytesMax: 0, rssBytesMean: 0 });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Start monitoring the given PID. Returns `stop()` which resolves to the
 * aggregate report when called.
 */
export function startResourceMonitor(rootPid, { intervalMs = 250 } = {}) {
  const stopRef = { stopped: false };
  const samples = [];
  const startMs = nowMs();
  const isLinux = platform() === 'linux';
  const diskStartPromise = isLinux ? readDiskstatsTotal() : null;
  const looper = (isLinux ? sampleLinux : sampleDarwin)(rootPid, intervalMs, stopRef, samples);
  return {
    async stop() {
      stopRef.stopped = true;
      await looper.catch(() => {});
      let diskWriteBytes = null;
      if (isLinux) {
        const a = await diskStartPromise;
        const b = await readDiskstatsTotal();
        if (a !== null && b !== null) diskWriteBytes = Math.max(0, b - a);
      }
      let diskMaxMBps = null;
      if (samples.length >= 2 && diskWriteBytes !== null) {
        const wallS = (samples[samples.length - 1].tMs - samples[0].tMs) / 1000;
        if (wallS > 0) diskMaxMBps = Number((diskWriteBytes / wallS / (1024 * 1024)).toFixed(1));
      }
      return {
        samplingMs: intervalMs,
        startedAtMs: startMs,
        endedAtMs: nowMs(),
        samples,
        diskWriteBytes,
        diskMaxMBps,
      };
    },
  };
}

/**
 * Convenience: run `fn` while monitoring `pid` and return both results.
 */
export async function withResourceMonitor(pid, fn, opts) {
  const mon = startResourceMonitor(pid, opts);
  try {
    const result = await fn();
    const report = await mon.stop();
    return { result, monitor: report };
  } catch (err) {
    await mon.stop().catch(() => {});
    throw err;
  }
}

/**
 * Summarize a monitor report into scalars suitable for tables:
 *   cpuPct.{p50,p95,max}, rssBytes.{p50,max}, diskWriteBytes, diskMaxMBps
 */
export function summarize(report) {
  const cpu = report.samples.map((s) => s.cpuPctMean).filter(Number.isFinite);
  const rss = report.samples.map((s) => s.rssBytesMax).filter(Number.isFinite);
  const sortedCpu = [...cpu].sort((a, b) => a - b);
  const sortedRss = [...rss].sort((a, b) => a - b);
  const q = (arr, p) =>
    arr.length === 0 ? null : arr[Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1))];
  return {
    cpuPctP50: q(sortedCpu, 50),
    cpuPctP95: q(sortedCpu, 95),
    cpuPctMax: sortedCpu.length ? sortedCpu[sortedCpu.length - 1] : null,
    rssBytesP50: q(sortedRss, 50),
    rssBytesMax: sortedRss.length ? sortedRss[sortedRss.length - 1] : null,
    diskWriteBytes: report.diskWriteBytes,
    diskMaxMBps: report.diskMaxMBps,
    samples: report.samples.length,
  };
}
