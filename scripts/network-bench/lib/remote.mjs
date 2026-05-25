/**
 * Minimal SSH/SCP wrappers used by the LAN and WAN runners.
 *
 * Style: pipe input via stdin instead of -e to keep multi-line scripts
 * portable across remote shells. Errors carry up to 300 chars of stderr
 * so failures are diagnosable from CI logs.
 */
import { spawn } from 'node:child_process';

const SSH_OPTS = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=15'];

export function sshRun(alias, command, { stdin = '', timeoutMs = 60000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(' ');
    const full = envPrefix ? `${envPrefix} ${command}` : command;
    const child = spawn('ssh', [...SSH_OPTS, alias, full], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ssh ${alias} timed out after ${timeoutMs}ms (cmd: ${command.slice(0, 80)})`));
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(`ssh ${alias} exit ${code}: ${stderr.slice(0, 300)}`));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

export function sshSpawn(alias, command, { env = {} } = {}) {
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  const full = envPrefix ? `${envPrefix} ${command}` : command;
  return spawn('ssh', [...SSH_OPTS, alias, full], { stdio: ['pipe', 'pipe', 'pipe'] });
}

export function scpUpload(localPath, alias, remotePath, { timeoutMs = 300000 } = {}) {
  return scpTimed(['-q', localPath, `${alias}:${remotePath}`], timeoutMs);
}

export function scpDownload(alias, remotePath, localPath, { timeoutMs = 300000 } = {}) {
  return scpTimed(['-q', `${alias}:${remotePath}`, localPath], timeoutMs);
}

/**
 * Time a scp invocation. Returns { wallMs, bytes } — bytes is the size of
 * the destination after transfer.
 */
function scpTimed(scpArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = hrMs();
    const child = spawn('scp', [...SSH_OPTS, ...scpArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`scp timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(`scp exit ${code}: ${stderr.slice(0, 300)}`));
      else resolve({ wallMs: hrMs() - t0 });
    });
  });
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function hrMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
