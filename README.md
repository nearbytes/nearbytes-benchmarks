# nearbytes-benchmarks

Performance harness for Nearbytes: transfer-matrix comparisons (Nearbytes vs reference baselines) across **local**, **LAN**, and **WAN** topologies, plus sync campaigns and e2e tests.

## Quick start

```sh
yarn install && yarn build

# Copy the machine list template, then edit SSH aliases and workdirs:
cp config/local.example.json config/local.json

# Default benchmark — LOCAL + LAN (detached) + WAN, 30s per case, baselines included:
yarn bench
```

`yarn bench` is what you should run day to day. It launches a **detached** LAN run on your lab alice host (survives VPN disconnect), then runs local and WAN on this machine. Pull LAN results later with `yarn bench:lan:pull`.

## Configuration

One gitignored file lists every machine available for tests:

| File | Committed? | Purpose |
|------|------------|---------|
| `config/local.json` | No — copy from `config/local.example.json` | **Machines** (`local`, `lan.alice`/`bob`, `wan.alice`/`bob`) plus e2e path overrides |
| `config/local.example.json` | Yes | Template |

Legacy `config/bench-hosts.local.json` and `config/e2e.local.json` still work but are deprecated — merge them into `config/local.json`.

Each machine entry needs at minimum `label`, `ssh` (or `null` for this Mac), and `workdir` on remotes. LAN and WAN benchmarks refuse to start if the required pair is missing.

Default timing: **30 seconds** of measured wall time per workload case (`bench.targetMs` or `NEARBYTES_TRANSFER_TARGET_MS`). Baselines are always measured unless you pass `--nearbytes-only`.

## Transfer matrix (default benchmarks)

The transfer matrix compares Nearbytes file transfer against reference tools on the same wire:

| Topology | Peers | Discovery | Baselines |
|----------|-------|-----------|-----------|
| **local** | Loopback alice + bob on this machine | loopback | `nc`, `cp` |
| **lan** | Two lab hosts on the same VLAN | mDNS | `scp`, `rsync` (run from alice) |
| **wan** | This Mac (alice) ↔ remote bob | DHT (Hyperswarm) | `scp`, `rsync` |

Each case is a 64–128 MiB payload shape (burst and sequential). The runner repeats until the **target wall time** (default 30s) is reached, then records goodput in Mb/s. Nearbytes and baselines never run concurrently.

### Commands

| Command | What it does |
|---------|----------------|
| `yarn bench` | **Recommended.** LOCAL + LAN detached + WAN, 30s target, baselines on |
| `yarn bench:local` | Loopback transfer matrix only |
| `yarn bench:lan` | LAN on remote alice (detached; Mac can disconnect) |
| `yarn bench:wan` | WAN transfer matrix from this Mac |
| `yarn bench:lan:pull` | Copy finished LAN JSON from alice to `.local/bench/` |
| `yarn bench:lan:finish-paper` | Wait for LAN, pull, refresh paper figures |

Aliases: `yarn bench:protocol:local`, `:lan`, `:wan` call the same entry points.

### LAN detached workflow

LAN data never flows through your Mac — alice orchestrates bob over the lab network.

```sh
yarn bench:lan                              # launch (returns immediately)
ssh pc-ciancia 'tail -f ~/nearbytes-bench/nearbytes-benchmarks/.local/tmp/transfer_lan_remote.log'
cat .local/tmp/transfer_lan_run.meta        # paths + status
yarn bench:lan:pull                         # when remote status=complete
```

### Short vs long runs

| Profile | How | Typical wall time |
|---------|-----|-------------------|
| **Default (short)** | `yarn bench` or any `bench:*` above | ~30s measured time per case; full matrix ~few minutes per topology |
| **Custom target** | `NEARBYTES_TRANSFER_TARGET_MS=120000 yarn bench:local` | Scales repeat count to hit target |
| **Smoke** | `NEARBYTES_PROTOCOL_SMOKE=1 yarn bench:protocol:suite:local` | Chat/replay suite only, not transfer matrix |
| **Nearbytes only** | `yarn bench:protocol:transfer-matrix -- --nearbytes-only --categories local` | Skips baseline phase |
| **Full protocol suite** | `yarn bench:protocol:suite:local` / `:lan` / `:wan` | Chat sync, replay, 16–64 MiB files (legacy harness) |

Results land under `.local/bench/protocol/` as JSON (`transfer-matrix-local.json`, `transfer-matrix-wan.json`, timestamped LAN files).

## Other harnesses

**Sync campaign** (friend-carriage throughput, multi-seed):

```sh
NEARBYTES_CAMPAIGN_SMOKE=1 yarn bench:campaign   # ~15s smoke
yarn bench:campaign                               # full K=5 campaign
```

**Network bench** (size-class sweeps, separate from transfer matrix):

```sh
yarn bench:network:local
yarn bench:network:lan    # needs config/local.json
yarn bench:network:wan
```

**E2e** (bidirectional sync, propagation, remote metrics) use the same `config/local.json` e2e section:

```sh
yarn e2e:bidirectional:local
yarn e2e:remote
```

Methodology: `requirements/benchmark-methodology-v1.md`, `requirements/protocol-benchmark-v1.md`.

Paper figures: from `paper-nearbytes-hypercore`, `yarn data:pull` then `yarn figures:protocol`.

## Dependencies

Internal Nearbytes packages are pinned in `package.json` as `github:nearbytes/<pkg>#<commit-sha>`. `yarn install` (Yarn 4.15 via Corepack) resolves each pin. Refresh pins with `yarn update`.
