# Benchmark methodology v1 (friend carriage / Implementation 0)

Requirements for reproducible performance numbers reported in `paper-nearbytes-hypercore`.

## Profiles

| Profile | Env | Purpose |
|---------|-----|---------|
| `quick` | `NEARBYTES_BENCH_QUICK=1` | CI smoke (≤30s) |
| `latency-only` | `NEARBYTES_BENCH_PROFILE=latency-only` | Fast latency sweep |
| `full` | default | Legacy 6-size × 5 repeat + 12×1 MiB batch |
| `paper` | `NEARBYTES_BENCH_PROFILE=paper` | Publication: warmup discard, 10×/size, stream sweep |

## Paper profile workload

- **Latency sizes:** 4 KiB, 64 KiB, 256 KiB, 1 MiB, 4 MiB.
- **Repeats:** 5 per size by default (env `NEARBYTES_BENCH_LATENCY_REPEATS`; was 10).
- **Warmup:** 1 payload at smallest size, excluded from manifest (`bench-lat-warm-*`).
- **Throughput:** stream mode; default sizes **1 MiB, 32 MiB, 128 MiB** (`NEARBYTES_BENCH_STREAM_SIZES` override).
- **Inter-stream pause:** 2 s (`NEARBYTES_BENCH_STREAM_INTER_MS`).

## Commands

| Step | Command | Output |
|------|---------|--------|
| Single exploratory run | `yarn e2e:paper:local` | `bench-report.json` + terminal summary |
| Multi-seed campaign | `yarn e2e:paper:campaign` or `yarn bench:paper` | `bench-campaign-report.json` + terminal; `latest/` symlink |
| Fast smoke (~15s) | `NEARBYTES_PAPER_BENCH_SMOKE=1 yarn bench:paper` | 1 seed, 2×5 latency, 1+4 MiB streams (no 32/128 MiB) |
| Paper LaTeX only | `yarn paper:figures` | `paper-nearbytes-hypercore/figures/*.tex` from existing JSON |

Benchmarks and LaTeX are **separate**: e2e targets never call `render-benchmark-figures.mjs`. JSON reports use `schemaVersion: 1` and 2-space formatting (`scripts/bench-json.mjs`).

## Campaign (publication tables)

```bash
cd nearbytes-benchmarks
yarn e2e:paper:campaign   # default K=5 seeds
yarn paper:figures        # after a successful campaign (reads latest report by default)
```

| Env | Default | Role |
|-----|---------|------|
| `NEARBYTES_BENCH_CAMPAIGN_SEEDS` | 5 | Independent full paper runs |
| `NEARBYTES_PAPER_BENCH_SMOKE` | unset | `1` → 1 seed, 2 latency repeats, smaller streams |
| `NEARBYTES_BENCH_STREAM_SIZES` | 1M,32M,128M | Goodput sweep |
| `NEARBYTES_BENCH_*_TIMEOUT_MS` | 0 (paper) | `0` = event-driven waits (no wall-clock caps) |

Per seed: Alice sender + Bob receiver → `seed-N/bench-report.json`.  
Aggregate: `bench-campaign-report.json` (also copied to `e2e-paper-campaign/latest/`).  
LaTeX: `yarn paper:figures` → `paper-nearbytes-hypercore/figures/`.

### Statistics

| Metric | Unit of analysis | CI method |
|--------|------------------|-----------|
| Latency | Pool all trials across seeds ($n = K \times$ repeats) | Student-$t$ on mean |
| Goodput | One sample per seed per stream size | Bootstrap 2000×, 2.5–97.5% |
| Publish CPU | Mean `publishCpuMs` per seed per size (latency + stream) | Bootstrap across seeds |
| Friend session | One sample per seed per role | Report $p_{50}$ in campaign summary |

## Metrics

### Latency (`oneWayLatencyMs`)

- **Start:** sender `file-published` marker (`sync/activity.log`).
- **End:** receiver first `inbound-stored` block matching payload size (±512 B framing).
- **Excluded:** trials named `bench-lat-warm-*` (warmup).
- **Statistics:** per size — n, min, p50, p95, mean, 95% CI of mean (Student-t).

### Throughput (goodput)

- **Payload:** per-stream `bench-tp-stream-{index}.bin` (paper: 1 / 32 / 128 MiB).
- **Phase markers:** sender `throughput-phase-start/end` with `streamIndex`; merge matches receiver `inbound-stored` blocks in that window.
- **Goodput:** `8 × nominal_bytes / (t_last − t_first)` over large inbound blocks (≥ min block threshold by size).
- **Receiver completion:** inbound bytes + optional `listFiles`; progress logs use inbound bytes (not only `listFiles 0/1`).
- **Waits (paper):** event-driven — receiver waits for `bench-phase-latency-complete.txt` / stream completion / peer ack files; env timeout ms `0` disables wall clocks (legacy profiles may still set limits).
- Includes encryption, volume journal, sync framing — not wire-line iperf.

### Publish CPU (`publishCpuMs`)

- **Measure:** `process.hrtime` around `fileService.addFile()` on sender (latency trials and each stream publish).
- **Not:** isolated encrypt-only microbenchmark.
- **Campaign table:** per payload size, mean across trials in seed, then bootstrap CI across seeds.

### Phases

- **Boot:** config + skeleton + sync start.
- **Friend session:** until `friend-session-attached` (handshake + mDNS/Hyperswarm).
- **Not included in latency:** discovery warmup and friend-session setup.

## Topology

Report topology explicitly in merge (`--topology`). Do not mix localhost and WAN in one table.

## Artifacts

- Per role: `benchmark-result.json`, `trial-manifest.json` (sender).
- Per seed: `bench-report.json` via `merge-benchmark-results.mjs`.
- Campaign: `bench-campaign-report.json` via `aggregate-campaign.mjs`.
- LaTeX: `yarn paper:figures` (`render-benchmark-figures.mjs`) → `paper-nearbytes-hypercore/figures/` (tables + pgfplots figures).

## Limitations (must state in paper)

- Application-level goodput, not isolated link capacity.
- Cross-host latency assumes NTP within a few ms or uses receiver-only markers.
- Single friend pair; no churn, overlap, or hub-peer experiments in v0 harness.
- Localhost campaign; WAN requires `e2e:remote:paper` per topology.
