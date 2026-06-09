/**
 * Runtime optimization toggles (all enabled by default).
 * Disable with NEARBYTES_OPT_<NAME>=0 or --opt-off <name> on the harness CLI.
 */
export const OPT_DEFS = [
  { id: 'burst-parallel', env: 'NEARBYTES_OPT_BURST_PARALLEL', label: 'Parallel burst publish (Promise.all addFile)' },
  { id: 'pregen-payload', env: 'NEARBYTES_OPT_PREGEN_PAYLOAD', label: 'Pre-generate payloads before addFile' },
  { id: 'overlap-expect', env: 'NEARBYTES_OPT_OVERLAP_EXPECT', label: 'Await publish and expect concurrently (vs. publish then expect)' },
  { id: 'inflight-dedup', env: 'NEARBYTES_OPT_INFLIGHT_DEDUP', label: 'In-flight want deduplication (sync)' },
  { id: 'tcp-bulk', env: 'NEARBYTES_OPT_TCP_BULK', label: 'TCP bulk sender (readSync + cork)' },
  { id: 'hash-pool', env: 'NEARBYTES_OPT_HASH_POOL', label: 'SHA-256 worker pool on receive' },
  {
    id: 'publish-pipeline',
    env: 'NEARBYTES_OPT_PUBLISH_PIPELINE',
    label: 'Burst publish with limited concurrency (pipeline encrypt onto wire)',
  },
] as const;

export type OptId = (typeof OPT_DEFS)[number]['id'];

export function optEnabled(envName: string, defaultOn = true): boolean {
  const v = process.env[envName];
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  return defaultOn;
}

export function burstParallelEnabled(): boolean {
  return optEnabled('NEARBYTES_OPT_BURST_PARALLEL');
}

export function pregenPayloadEnabled(): boolean {
  return optEnabled('NEARBYTES_OPT_PREGEN_PAYLOAD');
}

export function overlapExpectEnabled(): boolean {
  return optEnabled('NEARBYTES_OPT_OVERLAP_EXPECT');
}

export function publishPipelineEnabled(): boolean {
  return optEnabled('NEARBYTES_OPT_PUBLISH_PIPELINE', false);
}

export function publishPipelineWidth(): number {
  const raw = Number(process.env['NEARBYTES_OPT_PUBLISH_PIPELINE_WIDTH'] ?? '8');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
}
