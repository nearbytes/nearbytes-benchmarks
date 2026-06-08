/** Aggregate encode/decode CPU and RSS from transfer-matrix nearbytes runs. */

export function aggregateNearbytesResources(runs) {
  if (!runs?.length) return null;
  const encCpu = [];
  const decCpu = [];
  const encRss = [];
  const decRss = [];
  for (const r of runs) {
    if (r.encode?.publishCpuMs != null) encCpu.push(r.encode.publishCpuMs);
    if (r.decode?.receiveCpuMs != null) decCpu.push(r.decode.receiveCpuMs);
    if (r.encode?.encodeRssBytesMax != null) encRss.push(r.encode.encodeRssBytesMax);
    const decRssVal = r.decode?.decodeRssBytesMax ?? r.decode?.monitor?.rssBytesMax;
    if (decRssVal != null) decRss.push(decRssVal);
  }
  if (encCpu.length === 0 && decCpu.length === 0) return null;
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const max = (arr) => (arr.length ? Math.max(...arr) : null);
  return {
    encodeCpuMsMean: mean(encCpu),
    decodeCpuMsMean: mean(decCpu),
    encodeRssBytesMax: max(encRss),
    decodeRssBytesMax: max(decRss),
    samples: runs.length,
  };
}

export function fmtMiB(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  return Number((bytes / (1024 * 1024)).toFixed(1));
}
