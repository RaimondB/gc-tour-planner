# Planner benchmark harnesses

Offline tools for evaluating and tuning the tour planner against **real data**.
Each boots a headless Nest application context (the real planner, DB, OSRM, and
worker pool — no HTTP server, no auth guard) and runs over clusters discovered
for the cache-owning user.

They are **not** part of the running API — nothing imports them; each is a
standalone script with its own `main()`. Run them inside the api container so the
DB/OSRM/Valkey env and the compiled worker resolve correctly:

```bash
# build is produced by the normal api image build
docker compose exec api node dist/tours/bench/planner-sweep.js
docker compose exec api node dist/tours/bench/discovery-diag.js
```

## `planner-sweep.ts` — quality + speed leaderboard

Harvest many clusters across the whole DB (or a large circle) into a fixed,
cacheable corpus, then sweep planner settings over that corpus and rank them.
Settings are compared on **identical clusters**, so it's apples-to-apples. The
headline metric is **realised retrace** — overlap of the actual OSRM polyline
(grid-cell re-entries), measured independently of any solver heuristic.

A config is just a set of `PLANNER_*` env overrides applied before each
`planLoop`, so any per-plan knob is sweepable. Default sweep is
`PLANNER_LOOP_ALPHA` (the loop-picker overlap weight); override with a
`BENCH_CONFIGS` JSON file:

```json
[
  { "label": "alpha0", "env": { "PLANNER_LOOP_ALPHA": "0" } },
  { "label": "trim-tight", "env": { "PLANNER_MARGINAL_DROP_RATIO": "1.5" } }
]
```

Corpus env: `BENCH_OWNER_ID`, `BENCH_CENTER` (`"lng,lat"`), `BENCH_AREA_RADIUS_M`,
`BENCH_SEED_SPACING_M`, `BENCH_MAX_SEEDS`, `BENCH_TOPN`, `BENCH_MAX_CLUSTERS`,
`BENCH_RADIUS_M`, `BENCH_MAX_CACHES`, `BENCH_BUDGET_M`, `BENCH_CORPUS_FILE`
(cache the corpus for re-runs). Sweep env: `BENCH_CONFIGS`, `BENCH_OUT`.

## `discovery-diag.ts` — Pass-1 invariant diagnostics

Quantifies the `[discover-compute] … refine→pool invariant broken` warning by
running discovery across many seeds and detecting clusters whose ids aren't in
the candidate pool (from the returned `diagnostics`), then classifying those
foreign ids against the DB. Uses the same corpus seeding env knobs.

## Shared modules

- `bench-metrics.ts` — realised retrace, Jaccard, mean/median, env parsing.
- `corpus.ts` — owner resolution, seed picking, corpus harvesting.
