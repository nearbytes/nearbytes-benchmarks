# nearbytes-benchmarks

Performance harness for Nearbytes friend-carriage sync (Alice/Bob profiles, campaigns, paper figures).

Requires sibling packages: `nearbytes-files`, `nearbytes-crypto`, `nearbytes-log`, `nearbytes-skeleton`, `nearbytes-sync`.

```sh
yarn install && yarn build
NEARBYTES_PAPER_BENCH_SMOKE=1 yarn bench:paper   # ~15s smoke
yarn bench:paper                                 # full campaign
yarn paper:figures                               # LaTeX → paper-nearbytes-hypercore/figures
```

Methodology: `requirements/benchmark-methodology-v1.md`.
