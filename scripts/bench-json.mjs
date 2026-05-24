/**
 * Stable JSON read/write for benchmark reports.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

export const BENCH_REPORT_SCHEMA = 1;

export function normalizeReport(obj) {
  if (obj && typeof obj === 'object' && obj.schemaVersion == null) {
    return { schemaVersion: BENCH_REPORT_SCHEMA, ...obj };
  }
  return obj;
}

export async function readBenchReport(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return normalizeReport(JSON.parse(raw));
}

export async function writeBenchReport(filePath, data) {
  const body = { schemaVersion: BENCH_REPORT_SCHEMA, ...data };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
  return filePath;
}
