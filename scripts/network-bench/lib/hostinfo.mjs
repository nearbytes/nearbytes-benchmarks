/**
 * Cross-platform machine descriptor.
 *
 * Captures fields a paper reader needs to reproduce numbers: OS family,
 * kernel/distro, CPU model + core count, RAM, primary disk model and
 * type (NVMe/SSD/HDD), Node.js and tool versions. Works on macOS and
 * Linux; falls back to neutral strings on missing fields.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { availableParallelism, totalmem, platform, arch, release } from 'node:os';

const exec = promisify(execFile);

function sshWithStdin(sshAlias, remoteCmd, stdin, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [sshAlias, remoteCmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ssh ${sshAlias} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(`ssh ${sshAlias} exit ${code}: ${stderr.slice(0, 300)}`));
      else resolve(stdout);
    });
    child.stdin.end(stdin);
  });
}

async function tryRun(cmd, args, opts = {}) {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 4000, ...opts });
    return stdout;
  } catch {
    return '';
  }
}

async function macInfo() {
  const cpu = (await tryRun('sysctl', ['-n', 'machdep.cpu.brand_string'])).trim();
  const cores = (await tryRun('sysctl', ['-n', 'hw.physicalcpu'])).trim();
  const logical = (await tryRun('sysctl', ['-n', 'hw.logicalcpu'])).trim();
  const swVers = (await tryRun('sw_vers')).trim();
  const diskRoot = (await tryRun('diskutil', ['info', '/'])).trim();
  const diskMedium = /Media Name:\s*([^\n]+)/.exec(diskRoot)?.[1]?.trim() ?? '';
  const diskProtocol = /Protocol:\s*([^\n]+)/.exec(diskRoot)?.[1]?.trim() ?? '';
  return {
    osName: 'macOS',
    osVersion: /ProductVersion:\s*([^\n]+)/.exec(swVers)?.[1]?.trim() ?? release(),
    kernel: release(),
    cpuModel: cpu || 'unknown',
    cpuPhysicalCores: Number(cores) || 0,
    cpuLogicalCores: Number(logical) || availableParallelism(),
    diskModel: diskMedium,
    diskProtocol,
  };
}

async function linuxInfo() {
  const lsb = (await tryRun('lsb_release', ['-ds'])).trim();
  const kernel = (await tryRun('uname', ['-sr'])).trim();
  const cpuinfo = await tryRun('lscpu', []);
  const cpuModel = /Model name:\s*(.+)/.exec(cpuinfo)?.[1]?.trim() ?? 'unknown';
  const physical =
    Number(/Core\(s\) per socket:\s*(\d+)/.exec(cpuinfo)?.[1] ?? 0) *
      Number(/Socket\(s\):\s*(\d+)/.exec(cpuinfo)?.[1] ?? 0) || 0;
  const logical = Number(/^CPU\(s\):\s*(\d+)/m.exec(cpuinfo)?.[1] ?? availableParallelism());

  // Primary disk = filesystem holding /, its parent block device, then the
  // model exposed by udev. Best-effort across the diversity of Linux layouts.
  const findmnt = (await tryRun('findmnt', ['-no', 'SOURCE', '/'])).trim();
  const partition = findmnt.replace(/^\/dev\//, '');
  const parent = (await tryRun('lsblk', ['-no', 'PKNAME', `/dev/${partition}`])).trim() || partition;
  const model = (await tryRun('lsblk', ['-dno', 'MODEL', `/dev/${parent}`])).trim();
  const rotational = (await tryRun('lsblk', ['-dno', 'ROTA', `/dev/${parent}`])).trim();
  const diskProtocol = parent.startsWith('nvme') ? 'NVMe' : rotational === '0' ? 'SSD' : 'HDD';

  return {
    osName: 'Linux',
    osVersion: lsb || release(),
    kernel,
    cpuModel,
    cpuPhysicalCores: physical || 0,
    cpuLogicalCores: logical,
    diskModel: model,
    diskProtocol,
  };
}

export async function collectLocalHostInfo() {
  const base = platform() === 'darwin' ? await macInfo() : await linuxInfo();
  const { stdout: node } = await exec(process.execPath, ['-v']);
  return {
    ...base,
    arch: arch(),
    memTotalGiB: Number((totalmem() / (1024 ** 3)).toFixed(1)),
    node: node.trim(),
    collectedAt: new Date().toISOString(),
  };
}

/**
 * Same collector, executed over SSH on a remote host. The remote runs
 * `node -e "..."` with this module's source inlined; we keep it portable
 * by re-implementing the Linux-only sniff inline (the remotes are all
 * Linux in this paper's setup).
 */
export async function collectRemoteHostInfo(sshAlias) {
  const script = String.raw`
const { execFileSync } = require('child_process');
const os = require('os');
const tryRun = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000 }); }
  catch { return ''; }
};
const lsb = tryRun('lsb_release', ['-ds']).trim();
const kernel = tryRun('uname', ['-sr']).trim();
const cpuinfo = tryRun('lscpu', []);
const cpuModel = (/Model name:\s*(.+)/.exec(cpuinfo)||[])[1]?.trim() ?? 'unknown';
const physical = (Number((/Core\(s\) per socket:\s*(\d+)/.exec(cpuinfo)||[])[1] ?? 0) *
                  Number((/Socket\(s\):\s*(\d+)/.exec(cpuinfo)||[])[1] ?? 0)) || 0;
const logical = Number((/^CPU\(s\):\s*(\d+)/m.exec(cpuinfo)||[])[1] ?? os.availableParallelism());
const findmnt = tryRun('findmnt', ['-no', 'SOURCE', '/']).trim();
const partition = findmnt.replace(/^\/dev\//, '');
const parent = tryRun('lsblk', ['-no', 'PKNAME', '/dev/' + partition]).trim() || partition;
const model = tryRun('lsblk', ['-dno', 'MODEL', '/dev/' + parent]).trim();
const rotational = tryRun('lsblk', ['-dno', 'ROTA', '/dev/' + parent]).trim();
const diskProtocol = parent.startsWith('nvme') ? 'NVMe' : rotational === '0' ? 'SSD' : 'HDD';
console.log(JSON.stringify({
  osName: 'Linux',
  osVersion: lsb || os.release(),
  kernel,
  cpuModel,
  cpuPhysicalCores: physical,
  cpuLogicalCores: logical,
  diskModel: model,
  diskProtocol,
  arch: process.arch,
  memTotalGiB: Number((os.totalmem() / (1024 ** 3)).toFixed(1)),
  node: process.version,
  collectedAt: new Date().toISOString(),
}));
`;
  const stdout = await sshWithStdin(sshAlias, 'node -', script);
  const last = stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(last);
}

export { sshWithStdin };
