/**
 * Deterministic payload generation. Each (size, seed) pair maps to a
 * unique byte sequence so receivers can validate by hash. Generation is
 * fast (XOR-stream) and avoids any I/O until the file is written.
 */
import { openSync, writeSync, closeSync } from 'node:fs';

export function writeDeterministicPayload(path, bytes, seed = 0) {
  const fd = openSync(path, 'w');
  const sliceLen = Math.min(bytes, 16 * 1024 * 1024);
  const buf = Buffer.allocUnsafe(sliceLen);
  let s = (seed + 1) >>> 0;
  for (let i = 0; i < sliceLen; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    buf[i] = s & 0xff;
  }
  let written = 0;
  while (written < bytes) {
    const need = Math.min(sliceLen, bytes - written);
    writeSync(fd, buf, 0, need, written);
    written += need;
  }
  closeSync(fd);
}
