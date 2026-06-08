# Protocol benchmark v1 (chat + files + replay)

Publication-grade measurements for Nearbytes hub-channel protocols over friend carriage (Impl.~0).

## Topology

| Category | Endpoints | Control plane |
|----------|-----------|---------------|
| `local` | Alice + Bob on loopback | this Mac |
| `lan` | two configured LAN peers | this Mac (SSH JSON only) |
| `wan` | this machine ↔ configured SSH remote | this machine (local peer + SSH JSON to remote peer) |

The `wan` topology MUST run with Hyperswarm-only discovery (`NEARBYTES_PROTOCOL_WAN_DISCOVERY=dht` or `hyperswarm`) so peer attachment, latency, and goodput are measured over the DHT path only. A WAN run MUST NOT be satisfied by mDNS/TCP LAN discovery.

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

### D. Transfer matrix (Nearbytes vs baselines)

`bench:protocol:transfer-matrix` measures Nearbytes file transfer, `scp`, and `rsync` in one orchestrated report for selectable topology categories: `local`, `lan`, `wan`, or a comma-separated combination. Each category runs in two phases: **phase 1** — Nearbytes for every case; **phase 2** — reference baselines (`nc`/`cp` on loopback; `scp`/`rsync` on LAN/WAN). Baselines never run concurrently with Nearbytes peers so measurements are paired without bandwidth contention.

**Topology (non-negotiable):**

| Category | Peers | Discovery | Orchestrator |
|----------|-------|-----------|--------------|
| `local` | loopback alice + bob on the Mac | mDNS | Mac |
| `lan` | CNR alice (`pc-ciancia`) ↔ CNR bob (`fmt-5000`) on the lab VLAN | **mDNS only** — no DHT | Mac SSH, or `pc-ciancia` with `--lan-alice-on-host` |
| `wan` | Mac alice ↔ CNR bob (`zombie`) over the public internet | **DHT only** — no mDNS | Mac |

The Mac MUST NOT be a Nearbytes protocol peer in the `lan` category. Running LAN with the Mac as alice was a harness bug (mDNS cannot rendezvous Mac↔CNR across VPN). WAN MUST use `NEARBYTES_SYNC_DISCOVERY=dht` (or `hyperswarm`); LAN MUST use `mdns`.

`scp` and `rsync` baselines MUST use **one batched transfer invocation per repetition** for multi-file cases:

- **LAN** (CNR alice→CNR bob): one `scp -O` with all source paths, or one `rsync` with all sources; wall clock measured on alice (SSH from Mac is control plane only).
- **WAN** (Mac alice → CNR bob): one `scp -O` or one `rsync` from the Mac orchestrator, same batched semantics.
- **Local**: `nc` uses concurrent loopback listeners (one per file); `cp` uses parallel filesystem copies.

Remote `scp` baselines MUST use classic scp mode (`scp -O`) so many-small-file rows measure scp transfer behaviour rather than OpenSSH SFTP batching stalls.

Each system/case SHOULD repeat until at least 10 s of measured wall time is accumulated (cap: eight trials). Reports MUST include `repeats`, `wallMs`, `bytes`, `goodputMbps`, and `targetReached`; when the repeat cap prevents reaching the target duration, consumers MUST treat that row as short-duration evidence rather than a full-duration benchmark.

**SSH to CNR hosts:** The harness MUST minimize distinct SSH handshakes to institutional machines (`pc-ciancia`, `fmt-5000`, `zombie`). LAN opens one `SshMaster` per remote CNR host; WAN opens one for bob. WAN uses a fresh Nearbytes friend session per row (shared WAN sessions wedge after the first burst); LAN reuses one warm mDNS friend session for all Nearbytes rows. Use `--skip-deploy` when remotes are already built. Do not run triple `sshPreflight` retries against CNR sshd.

Reports MUST include a `topology` block per category (`peers`, `discovery`, `alice`, `bob`, `orchestrator`).

**Latest matrix (2026-06-08):**

| Category | Source | Nearbytes highlight |
|----------|--------|---------------------|
| `local` | `transfer-matrix-local-full.json` | 132–10\,737 Mb/s vs `nc`/`cp` (encryption tax on loopback) |
| `lan` | `transfer-matrix-lan-full.json` | ~81–88 Mb/s, within ~5% of batched `scp`/`rsync` on `pc-ciancia`↔`fmt-5000` |
| `wan` | `transfer-matrix-wan-full.json` (2026-06-08) | many-small-file rows trail `rsync` (~18–25 vs ~58 Mb/s); 128 MiB seq ~57 Mb/s (parity with `scp`/`rsync`) Mac↔`zombie` over DHT |

The transfer matrix uses the same configured machine list as the network/protocol benchmarks (`config/local.json`, `machines` section). `wan` MUST use two different peer identities and Hyperswarm-only discovery. `lan` uses the configured LAN Alice/Bob machines, and `local` uses loopback Alice/Bob peers.

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
yarn bench:protocol:wan
yarn bench
NEARBYTES_TRANSFER_TARGET_MS=120000 yarn bench:protocol:transfer-matrix -- --categories wan,lan,local
NEARBYTES_PROTOCOL_WAN_DISCOVERY=dht yarn bench:protocol:wan
NEARBYTES_PROTOCOL_SMOKE=1 yarn bench:protocol:local
```

Console output is a mild `[step/total]` progress line per recorded trial; setup and completion status lines are unnumbered. Skipped cumulative targets that are already satisfied by warmup are excluded from the total. Details live in per-trial `.json` / `.log` files.
