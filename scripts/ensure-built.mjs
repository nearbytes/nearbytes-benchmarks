import { access } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const benchRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const filesRoot = path.join(benchRoot, '..', 'nearbytes-files');

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → exit ${c}`))));
  });
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code !== 'ENOENT') {
      console.warn(`[ensure-built] access(${p}):`, err);
    }
    return false;
  }
}

export async function ensureBenchmarkBuilt() {
  const filesCtx = path.join(filesRoot, 'dist/cli/context.js');
  const benchBin = path.join(benchRoot, 'dist/sync-benchmark.js');
  if (!(await exists(filesCtx))) {
    console.log('Building nearbytes-files…');
    await run('npm', ['run', 'build'], filesRoot);
  }
  if (!(await exists(benchBin))) {
    console.log('Building nearbytes-benchmarks…');
    await run('npm', ['run', 'build'], benchRoot);
  }
}
