/**
 * Reference baselines for the three categories.
 *
 *   local:  nc (raw TCP wire)         + cp (filesystem)
 *   lan/wan: scp (encrypted transfer) + rsync (delta + checksum)
 *
 * Every runner returns:
 *   { wallMs, bytes, count, files: [{ name, bytes }] }
 *
 * For burst runs we issue N concurrent invocations, the same way the
 * nearbytes sender publishes N files in parallel — this is the most
 * apples-to-apples concurrency comparison against scp/rsync.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hrMs, shellQuote, sshRun } from './remote.mjs';

function runProc(cmd, args, { timeoutMs = 600000, env = process.env, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [stdin === null ? 'ignore' : 'pipe', 'ignore', 'pipe'],
      env,
    });
    let stderr = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 300)}`));
      else resolve();
    });
    if (stdin !== null) child.stdin.end(stdin);
  });
}

/**
 * Pick a free localhost port for a single-shot listener.
 */
async function pickPort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/* ───────────────────────── local: nc ─────────────────────────────────── */

/**
 * One nc invocation per file, transferred over loopback. The receiver
 * writes to disk (so we measure wire + write, parity with scp/rsync).
 *
 * Bursts are spawned concurrently with distinct ports so the wire is
 * not serialized; this is the closest "nc analog" of N concurrent fetches.
 */
export async function localNc(files, scratch) {
  const t0 = hrMs();
  // Pre-pick all listener ports BEFORE spawning anything so that concurrent
  // `createServer().listen(0)` calls don't race for the same kernel-assigned
  // port. We close the probe sockets but the kernel typically does not
  // immediately recycle the port; if it does, the actual nc listen below
  // surfaces an error event we can catch.
  const ports = [];
  for (let i = 0; i < files.length; i++) ports.push(await pickPort());
  await Promise.all(
    files.map((f, idx) =>
      runOneNc(f, scratch, ports[idx]),
    ),
  );
  return { wallMs: hrMs() - t0, bytes: totalBytes(files), count: files.length };
}

async function runOneNc(f, scratch, port) {
  const dst = join(scratch, `nc-${f.name}.bin`);
  const listenerDone = new Promise((resolve, reject) => {
    const listener = spawn('sh', [
      '-c',
      `nc -l ${port} > ${shellQuote(dst)}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    listener.on('error', reject);
    listener.on('close', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`nc listener on :${port} exit ${code}`));
    });
    // The listener spawn may keep stderr full; drain it.
    listener.stderr.resume();
  });
  // Give the listener a moment to bind. 50ms is generous on loopback.
  await new Promise((res) => setTimeout(res, 50));
  await runProc('sh', ['-c', `nc 127.0.0.1 ${port} < ${shellQuote(f.path)}`]);
  await listenerDone;
}

/* ───────────────────────── local: cp ─────────────────────────────────── */

export async function localCp(files, scratch) {
  const t0 = hrMs();
  await Promise.all(
    files.map((f) => {
      const dst = join(scratch, `cp-${f.name}.bin`);
      try {
        unlinkSync(dst);
      } catch {
        /* not present */
      }
      return runProc('cp', [f.path, dst]);
    }),
  );
  return { wallMs: hrMs() - t0, bytes: totalBytes(files), count: files.length };
}

/* ─────────────────────── lan/wan: scp ────────────────────────────────── */

/**
 * scp from the local sender to a remote receiver workdir. N files are
 * scp'd in parallel (one ssh connection each) to match nearbytes burst
 * semantics. The remote workdir must exist; the caller is responsible.
 */
export async function remoteScp(files, sshAlias, remoteDir) {
  const t0 = hrMs();
  await Promise.all(
    files.map((f) =>
      runProc('scp', [
        '-q',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ServerAliveInterval=15',
        f.path,
        `${sshAlias}:${remoteDir}/scp-${f.name}.bin`,
      ]),
    ),
  );
  return { wallMs: hrMs() - t0, bytes: totalBytes(files), count: files.length };
}

/* ─────────────────────── lan/wan: rsync ──────────────────────────────── */

/**
 * rsync over ssh. We disable compression (-z) and force whole-file (-W)
 * so we measure the wire + checksum overhead without the algorithm's
 * delta-encoding kicking in. This makes results comparable with scp
 * (which has neither feature).
 */
export async function remoteRsync(files, sshAlias, remoteDir) {
  const t0 = hrMs();
  await Promise.all(
    files.map((f) =>
      runProc('rsync', [
        '-W', '--inplace',
        '-e', 'ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15',
        f.path,
        `${sshAlias}:${remoteDir}/rsync-${f.name}.bin`,
      ]),
    ),
  );
  return { wallMs: hrMs() - t0, bytes: totalBytes(files), count: files.length };
}

/* ───────────────────────── helpers ───────────────────────────────────── */

export function totalBytes(files) {
  return files.reduce((a, f) => a + f.bytes, 0);
}

export async function prepareRemoteDir(sshAlias, dir) {
  await sshRun(sshAlias, `mkdir -p ${shellQuote(dir)} && rm -f ${shellQuote(dir)}/*.bin`);
}

export function cleanScratch(scratch) {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function mkScratch() {
  return mkdtempSync(join(tmpdir(), 'nb-netbench-'));
}
