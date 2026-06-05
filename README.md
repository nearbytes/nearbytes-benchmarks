# nearbytes-benchmarks

Performance harness for Nearbytes friend-carriage sync: Alice/Bob roles,
profiles, multi-seed campaigns, LaTeX figure rendering.

Internal Nearbytes deps (`nearbytes-crypto`, `nearbytes-log`,
`nearbytes-skeleton`, `nearbytes-files`) are pinned in `package.json`
as `github:nearbytes/<pkg>#<commit-sha>`. Plain `yarn install` (Yarn
4.15 via Corepack) resolves each pinned commit and packs it via its
own `prepack: tsc` — no sibling checkouts required. To refresh the
pinned SHAs to current `main` HEADs, run `yarn update`.

```sh
yarn install && yarn build

# fast smoke (~15s)
NEARBYTES_CAMPAIGN_SMOKE=1 yarn bench:campaign

# multi-seed campaign (default K=5)
yarn bench:campaign

# bidirectional 1 MiB friend-sync round-trip (~12s wall)
yarn e2e:bidirectional:local

# render LaTeX tables/figures from the latest campaign report
yarn report:figures
# customise the output directory with:
#   NEARBYTES_REPORT_FIGURES_DIR=/path/to/figures yarn report:figures
```

Methodology: `requirements/benchmark-methodology-v1.md`.

Protocol benchmark (chat + 16--64 MiB files + replay scaling):

```sh
yarn bench:protocol:local
yarn bench:protocol:lan    # needs config/bench-hosts.local.json
NEARBYTES_PROTOCOL_SMOKE=1 yarn bench:protocol:local
```

Methodology: `requirements/protocol-benchmark-v1.md`. Paper figures: `yarn data:pull` then `yarn figures:protocol` in `paper-nearbytes-hypercore`.
