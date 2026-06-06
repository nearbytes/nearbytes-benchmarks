# Protocol benchmark v1 (chat + files + replay)

Publication-grade measurements for Nearbytes hub-channel protocols over friend carriage (Impl.~0).

## Topology

| Category | Endpoints | Control plane |
|----------|-----------|---------------|
| `local` | Alice + Bob on loopback | this Mac |
| `lan` | `pc-ciancia` ↔ `zombie` | this Mac (SSH JSON only) |

## Credentials

`src/benchmark-credentials.ts` — profiles + `nearbytes-bench:beautiful-document` hub.

## Workloads

### A. Chat sync (cumulative)

Targets $N \in \{1,10,50,100,250,500\}$; 256 B bodies; amortized ms/message from batch wall / $\Delta$.

### B. File bursts (≤16 MiB per file)

Each file is **16 MiB** max. Scale aggregate load by count $K$:

| $K$ | Mode | Aggregate |
|-----|------|-----------|
| 1 | sequential | 16 MiB |
| 4 | parallel burst | 64 MiB |
| 8 | parallel burst | 128 MiB |
| 16 | parallel burst | 256 MiB |

Goodput uses total bytes / wall time. Timeout scales with aggregate size (LAN allows longer caps). Goodput confidence intervals are bounded at 0; summaries must not report negative lower bounds for nonnegative physical metrics.

### C. Replay

Cold `readChatTimeline` + `getReplayContext` after `markReplayStale` at chat checkpoints and at end.

## Test database layout

Each run creates a timestamped directory:

```
.local/bench/protocol/db/<category>-<ISO-stamp>/
  orchestrator.log
  session.json
  manifest.json
  summary.json
  chat-target-0100.json
  chat-target-0100.log
  file-16mib-x08-burst-rep02.json
  file-16mib-x08-burst-rep02.log
  replay-final.json
  …
```

Symlink-style aggregates for tooling:

- `.local/bench/protocol/local-results.json` ← latest local `summary.json`
- `.local/bench/protocol/lan-results.json` ← latest LAN `summary.json`

## Commands

```bash
yarn bench:protocol:clean
yarn build
yarn bench:protocol:local
yarn bench:protocol:lan
NEARBYTES_PROTOCOL_SMOKE=1 yarn bench:protocol:local
```

Console output is a mild `[step/total]` progress line per recorded trial; setup and completion status lines are unnumbered. Skipped cumulative targets that are already satisfied by warmup are excluded from the total. Details live in per-trial `.json` / `.log` files.
