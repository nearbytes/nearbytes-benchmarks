# nearbytes-benchmarks

Performance harness for Nearbytes friend-carriage sync: Alice/Bob roles,
profiles, multi-seed campaigns, LaTeX figure rendering.

Requires sibling packages: `nearbytes-files`, `nearbytes-crypto`,
`nearbytes-log`, `nearbytes-skeleton`, `nearbytes-sync`. Run
`node ../nearbytes-files/scripts/update.mjs` once to clone + build them
all (subsequent updates: `yarn update` from `nearbytes-files`), then:

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
