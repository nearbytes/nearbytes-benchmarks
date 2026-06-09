import { existsSync, readFileSync, statSync } from 'node:fs';

export function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function fileAgeMs(path) {
  if (!existsSync(path)) return Infinity;
  return Date.now() - statSync(path).mtimeMs;
}

/** @param {number} maxHours default from NEARBYTES_PAPER_MAX_AGE_HOURS or 12 */
export function maxAgeMs() {
  const h = Number(process.env.NEARBYTES_PAPER_MAX_AGE_HOURS ?? 12);
  return (Number.isFinite(h) && h > 0 ? h : 12) * 3600_000;
}

export function isForced() {
  return process.env.NEARBYTES_PAPER_FORCE === '1';
}

export function isFreshFile(path, maxMs = maxAgeMs()) {
  if (isForced()) return false;
  return fileAgeMs(path) < maxMs;
}

export function isFreshTransferMatrix(path) {
  if (!isFreshFile(path)) return false;
  const j = readJson(path);
  return j?.status === 'complete' && Array.isArray(j.results?.[j.categories?.[0]]);
}
