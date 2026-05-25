import { spawn, execSync } from 'child_process';
import path from 'path';
import { getRepoRoot } from './config.mjs';

/** Stop orphaned sync-benchmark children from aborted runs (prevents duplicate peers/acks). */
export function killStaleBenchProcesses() {
  try {
    execSync('pkill -f "dist/sync-benchmark.js" 2>/dev/null || true', {
      stdio: 'ignore',
    });
  } catch (err) {
    console.warn('[nearbytes-benchmarks] killStaleBenchProcesses:', err);
  }
}

export function stopBenchChild(child) {
  if (child && !child.killed) {
    child.kill('SIGTERM');
  }
}

export function benchScriptPath() {
  return path.join(getRepoRoot(), 'dist/sync-benchmark.js');
}

export function spawnBench(role, envExtra = {}, options = {}) {
  const root = getRepoRoot();
  const env =
    options.env === 'replace' ? envExtra : { ...process.env, ...envExtra };
  const child = spawn(process.execPath, [benchScriptPath()], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d) => {
    const t = d.toString();
    out += t;
    for (const line of t.split('\n').filter(Boolean)) {
      console.log(`[${role}] ${line}`);
    }
  });
  child.stderr?.on('data', (d) => {
    const t = d.toString();
    for (const line of t.split('\n').filter(Boolean)) {
      console.error(`[${role}] ${line}`);
    }
  });
  return {
    child,
    wait: () =>
      new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code === 0 || code === 143 || code === null) resolve(out);
          else reject(new Error(`${role} exited ${code}`));
        });
      }),
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
