/**
 * Minimal SSH/SCP wrappers used by the LAN and WAN runners.
 *
 * Style: pipe input via stdin instead of -e to keep multi-line scripts
 * portable across remote shells. Errors carry up to 300 chars of stderr
 * so failures are diagnosable from CI logs.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';

const SSH_OPTS = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=15'];

/**
 * One persistent SSH ControlMaster per remote host.
 *
 * Hammering scp/rsync/ssh against the same sshd over a 42 ms WAN burns
 * CPU on the receiver, fills its connection backlog, and trips
 * institutional firewalls into rate-limiting the source IP. With a
 * ControlMaster, every subsequent scp/rsync/ssh reuses one TCP+TLS
 * channel — zero handshake cost per transfer and no chance of
 * tripping MaxStartups / fail2ban.
 *
 * Lifetime is bound to the orchestrator process: started before any
 * baseline runs, closed in the `finally` block of run-wan.mjs.
 */
export class SshMaster {
  constructor(alias) {
    this.alias = alias;
    this.sock = join(tmpdir(), `nb-ssh-master-${alias}-${process.pid}.sock`);
    this._started = false;
  }

  /** Options to splice into ssh / scp / rsync's "-e ssh …" so they
   * reuse this master. Returned as a flat string array. */
  sshOpts() {
    return ['-o', `ControlPath=${this.sock}`, '-o', 'ControlMaster=no'];
  }

  /** "ssh-style" string suitable for rsync's `-e` flag. */
  rsyncRsh() {
    return `ssh ${this.sshOpts().join(' ')} -o StrictHostKeyChecking=accept-new`;
  }

  async start() {
    if (this._started) return;
    if (existsSync(this.sock)) {
      try { unlinkSync(this.sock); } catch { /* stale */ }
    }
    await new Promise((resolve, reject) => {
      const child = spawn(
        'ssh',
        [
          ...SSH_OPTS,
          '-fNM',
          '-o', `ControlPath=${this.sock}`,
          '-o', 'ControlPersist=600',
          this.alias,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`ssh master start ${this.alias} exit ${code}: ${stderr.slice(0, 300)}`));
        else { this._started = true; resolve(); }
      });
    });
  }

  async stop() {
    if (!this._started) return;
    await new Promise((resolve) => {
      const child = spawn('ssh', ['-O', 'exit', '-o', `ControlPath=${this.sock}`, this.alias], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });
    this._started = false;
  }
}

export function sshRun(alias, command, { stdin = '', timeoutMs = 60000, env = {}, master = null } = {}) {
  return new Promise((resolve, reject) => {
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(' ');
    const full = envPrefix ? `${envPrefix} ${command}` : command;
    const opts = master ? [...SSH_OPTS, ...master.sshOpts()] : SSH_OPTS;
    const child = spawn('ssh', [...opts, alias, full], { stdio: ['pipe', 'pipe', 'pipe'] });
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
