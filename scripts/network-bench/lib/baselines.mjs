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
import { mkdtempSync, rmSync, statSync, unlinkSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hrMs, shellQuote, sshRun, SshMaster } from './remote.mjs';
export { SshMaster };

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
 * scp from the local sender to a remote receiver workdir. One batched
 * `scp -O` invocation per measurement (all sources → one remote directory),
 * matching protocol-benchmark-v1 transfer-matrix baseline rules.
 *
 * `master` is an optional SshMaster (see remote.mjs). When provided, scp
 * multiplexes over a persistent SSH connection (required on WAN paths).
 */
export async function remoteScp(files, sshAlias, remoteDir, { master = null } = {}) {
  const extra = master ? master.sshOpts() : ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=15'];
  const t0 = hrMs();
  await runProc('scp', [
    '-q',
    '-O',
    ...extra,
    ...files.map((f) => f.path),
    `${sshAlias}:${remoteDir}/`,
  ]);
  return { wallMs: hrMs() - t0, bytes: totalBytes(files), count: files.length };
}

/* ─────────────────────── lan/wan: rsync ──────────────────────────────── */

/**
 * Rsync's *natural* mode: ONE invocation, all N files as sources, dumped
 * into one destination directory. Rsync pipelines the files over a
 * single ssh transport and pays its protocol startup (capability
 * negotiation, file list, generator/sender wiring) exactly once for
 * the whole batch. This is how rsync is meant to be used and the only
 * apples-to-apples comparison against Nearbytes' parallel multi-file
 * publish.
 *
 * Flags:
 *   -W            whole-file (no delta encoding — we measure the wire,
 *                  not rsync's incremental cleverness)
 *   --inplace     write directly to the destination path
 *
 * Compression is off by default in rsync (you opt in with -z), so no
 * explicit "--no-compress" is needed — and macOS' openrsync rewrite
 * doesn't accept that flag anyway.
 *
 * With `master` we point `-e ssh …` at the ControlMaster socket so
 * even the single ssh handshake is amortised across all runs.
 */
export async function remoteRsync(files, sshAlias, remoteDir, { master = null } = {}) {
  const rsh = master
    ? master.rsyncRsh()
    : 'ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15';
  const t0 = hrMs();
  await runProc('rsync', [
    '-W', '--inplace',
    '-e', rsh,
    ...files.map((f) => f.path),
    `${sshAlias}:${remoteDir}/`,
  ]);
  return { wallMs: hrMs() - t0, bytes: totalBytes(files), count: files.length };
}

/* ───────────────────────── helpers ───────────────────────────────────── */

export function totalBytes(files) {
  return files.reduce((a, f) => a + f.bytes, 0);
}

export async function prepareRemoteDir(sshAlias, dir, { master = null } = {}) {
  await sshRun(sshAlias, `mkdir -p ${shellQuote(dir)} && rm -f ${shellQuote(dir)}/*.bin`, { master });
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

/* ───────── lan/wan: alice→bob baselines (data path = LAN only) ─────── */

/**
 * Materialise a deterministic LCG payload of `bytes` at `${aliceWorkdir}/payloads/<name>`
 * on the alice host. Cheap on Linux (writes via dd-like loop in node).
 * Idempotent: the script `stat`s first and skips re-generation when the size matches.
 */
const PAYLOAD_GEN_SCRIPT = `
const fs=require('fs'); const path=require('path');
const [dir,name,bytes,seed]=process.argv.slice(2);
const out=path.join(dir,name);
fs.mkdirSync(dir,{recursive:true});
try{ const st=fs.statSync(out); if(st.size===Number(bytes)) { console.log('cached'); process.exit(0); } }catch{}
let s=Number(seed)>>>0; const CHUNK=1<<20; const buf=Buffer.allocUnsafe(CHUNK);
const fd=fs.openSync(out,'w');
let written=0;
while(written<Number(bytes)){
  const n=Math.min(CHUNK,Number(bytes)-written);
  for(let i=0;i<n;i+=4){ s=(s*1664525+1013904223)>>>0; buf.writeUInt32LE(s,i); }
  fs.writeSync(fd,buf,0,n);
  written+=n;
}
fs.closeSync(fd);
console.log('made',out,written);`;

function alicePayloadDir(aliceHost) {
  return `${aliceHost.workdir}/payloads`;
}

/** Write deterministic payload on the orchestrator host (no SSH hop). */
export function ensureLocalAlicePayload(aliceHost, name, bytes, seed) {
  const dir = alicePayloadDir(aliceHost);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, name);
  try {
    if (statSync(out).size === bytes) return out;
  } catch {
    /* create */
  }
  let s = Number(seed) >>> 0;
  const CHUNK = 1 << 20;
  const buf = Buffer.allocUnsafe(CHUNK);
  const fd = openSync(out, 'w');
  let written = 0;
  while (written < bytes) {
    const n = Math.min(CHUNK, bytes - written);
    for (let i = 0; i < n; i += 4) {
      s = (s * 1664525 + 1013904223) >>> 0;
      buf.writeUInt32LE(s, i);
    }
    writeSync(fd, buf, 0, n);
    written += n;
  }
  closeSync(fd);
  return out;
}

export async function ensureAlicePayload(aliceHost, name, bytes, seed, { local = false } = {}) {
  if (local || !aliceHost.ssh) {
    return ensureLocalAlicePayload(aliceHost, name, bytes, seed);
  }
  const dir = alicePayloadDir(aliceHost);
  const { REMOTE_NODE_BIN } = await import('./deploy.mjs');
  const nodeBin = REMOTE_NODE_BIN(aliceHost.workdir);
  await sshRun(aliceHost.ssh, `mkdir -p ${shellQuote(dir)} && ${shellQuote(nodeBin)} - ${shellQuote(dir)} ${shellQuote(name)} ${bytes} ${seed}`, {
    stdin: PAYLOAD_GEN_SCRIPT,
    timeoutMs: 60_000,
  });
  return `${dir}/${name}`;
}

/**
 * Run scp or rsync **on alice**, from alice→bob, returning the wall-clock
 * delta as measured by Node's hrtime on alice (parsed back to JS).
 *
 * The Mac is only a control plane: it spawns one SSH per measurement and
 * gets back a single integer (ns). The data path is strictly alice⇄bob LAN.
 */
function alicePushScript(bobHost, alicePaths, tool) {
  const bobDir = `${bobHost.workdir}/payloads-recv`;
  let body;
  if (tool === 'scp') {
    const sources = alicePaths.map((p) => shellQuote(p)).join(' ');
    const dst = `${shellQuote(`${bobHost.ssh}:${bobDir}/`)}`;
    body = `scp -q -O -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 ${sources} ${dst} </dev/null`;
  } else {
    const dst = `${bobHost.ssh}:${bobDir}/`;
    const sources = alicePaths.map((p) => shellQuote(p)).join(' ');
    body = `rsync -W --inplace -e ${shellQuote('ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15')} ${sources} ${shellQuote(dst)} </dev/null`;
  }
  return `
set -e
ssh -n -o StrictHostKeyChecking=accept-new ${shellQuote(bobHost.ssh)} ${shellQuote(`mkdir -p ${bobDir} && rm -f ${bobDir}/${tool}-*.bin`)} >/dev/null
T0=$(date +%s%N)
${body}
T1=$(date +%s%N)
echo "WALL_NS=$((T1-T0))"
`;
}

async function parseWallNs(stdout) {
  const m = stdout.match(/WALL_NS=(\d+)/);
  if (!m) throw new Error(`could not parse WALL_NS from: ${stdout.slice(0, 300)}`);
  return Number(m[1]) / 1e6;
}

async function alicePushTimed(aliceHost, bobHost, alicePaths, tool, { aliceLocal = false } = {}) {
  const script = alicePushScript(bobHost, alicePaths, tool);
  if (aliceLocal || !aliceHost.ssh) {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`local alice→bob ${tool} timed out`));
      }, 600_000);
      child.stdout.on('data', (c) => (stdout += c.toString()));
      child.stderr.on('data', (c) => (stderr += c.toString()));
      child.on('close', async (code) => {
        clearTimeout(t);
        if (code !== 0) reject(new Error(`local alice→bob ${tool} exit ${code}: ${stderr.slice(0, 300)}`));
        else resolve(parseWallNs(stdout));
      });
      child.stdin.end(script);
    });
  }
  const { stdout } = await sshRun(aliceHost.ssh, 'bash -s', { stdin: script, timeoutMs: 600_000 });
  return parseWallNs(stdout);
}

export async function lanScp(aliceHost, bobHost, alicePaths, opts = {}) {
  const wallMs = await alicePushTimed(aliceHost, bobHost, alicePaths, 'scp', opts);
  return { wallMs, count: alicePaths.length };
}

export async function lanRsync(aliceHost, bobHost, alicePaths, opts = {}) {
  const wallMs = await alicePushTimed(aliceHost, bobHost, alicePaths, 'rsync', opts);
  return { wallMs, count: alicePaths.length };
}
