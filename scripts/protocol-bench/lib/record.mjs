/**
 * Per-trial JSON + log files under a run directory (test database).
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function runDir(repoRoot, category) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(repoRoot, '.local/bench/protocol/db', `${category}-${stamp}`);
}

export function trialSlug(parts) {
  return parts.filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export class TestDb {
  constructor(root) {
    this.root = root;
    this.trials = [];
    this._step = 0;
    this._total = 0;
  }

  setTotal(n) {
    this._total = n;
  }

  async init(meta) {
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, 'session.json'), JSON.stringify(meta, null, 2));
    this._orchLog = join(this.root, 'orchestrator.log');
    await this.logLine(`run dir: ${this.root}`);
  }

  async logLine(line) {
    const ts = new Date().toISOString();
    await appendFile(this._orchLog, `${ts} ${line}\n`);
  }

  progress(msg) {
    this._step += 1;
    const n = this._total > 0 ? `[${this._step}/${this._total}] ` : '';
    process.stdout.write(`${n}${msg}\n`);
  }

  status(msg) {
    process.stdout.write(`${msg}\n`);
  }

  async recordTrial(slug, payload, { log } = {}) {
    const base = join(this.root, slug);
    const record = {
      slug,
      recordedAt: new Date().toISOString(),
      ...payload,
    };
    await writeFile(`${base}.json`, JSON.stringify(record, null, 2));
    if (log) {
      await writeFile(`${base}.log`, typeof log === 'string' ? log : log.join('\n') + '\n');
    }
    this.trials.push({ slug, ok: !record.error, phase: record.phase ?? 'unknown' });
    return record;
  }

  async writeManifest(extra = {}) {
    await writeFile(
      join(this.root, 'manifest.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          runDir: this.root,
          trials: this.trials,
          ...extra,
        },
        null,
        2,
      ),
    );
  }

  async writeSummary(summary) {
    await writeFile(join(this.root, 'summary.json'), JSON.stringify(summary, null, 2));
  }
}
