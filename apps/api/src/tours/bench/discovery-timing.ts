// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Discovery-timing lab: attribute the WALL-CLOCK latency of Pass-1 cluster
// discovery (`POST /tours/clusters`) across its phases. The other benches time
// clustering QUALITY (clustering-sweep) or end-to-end packing (cluster-tuning);
// neither tells you WHERE the seconds go. This one does, because the perceived
// "hdbscan-star is slow" is a misattribution — the algorithm is ~3 ms. The
// first run of this bench found the cost was the PostGIS k-NN over-fetch (one
// DB round-trip per origin), NOT the OSRM `/table` build as assumed — which is
// why you measure instead of guess (see the perf handoff).
//
// Per seed it runs the real discovery path twice and reports the split:
//   1. prepareClusteringContext (I/O — DB list, landuse, walking-graph), with a
//      phase breakdown: list / landuse / buildWalkingGraph (further split into
//      PostGIS over-fetch / route_legs cache-read / OSRM `/table` fetch /
//      persist / rank+symmetrise) / seeds.
//   2. The worker round-trip (computePool.computeClusters): structured-clone of
//      the full ctx out + result back + the pure compute. Isolated by also
//      running the SAME compute INLINE (computeClusters) — the delta is the
//      clone+dispatch overhead the worker boundary (ADR-0014) adds.
//
// Cold vs warm: pass A populates route_legs (mostly cold — OSRM misses), pass B
// re-runs the identical context (fully warm — route_legs hits). The A→B delta
// in `osrm.fetch` exposes any cold-OSRM cost the precompute / cache-hit-rate
// levers would attack (small on an already-warm area). Non-destructive: it only
// fills the cache, never clears it; on a warm area the two passes converge.
//
// Discovery is run INLINE (prepareClusteringContext, not planner.discoverClusters)
// so we can hold the ctx and time the worker round-trip separately; the planner
// does exactly the same two steps. Strategy defaults to the resolved planner
// strategy (PLANNER_CLUSTERING → hdbscan-star); override with BENCH_STRATEGY.
//
// Run inside the api container:
//   docker compose exec -e BENCH_MAX_SEEDS=40 -e BENCH_BUDGET_M=10000 \
//     api node dist/tours/bench/discovery-timing.js
//
// Env: BENCH_OWNER_ID, BENCH_CENTER, BENCH_AREA_RADIUS_M, BENCH_SEED_SPACING_M,
//   BENCH_MAX_SEEDS (def 40), BENCH_RADIUS_M, BENCH_BUDGET_M, BENCH_MAX_LINK_M,
//   BENCH_MIN_CLUSTER_SIZE, BENCH_STRATEGY (def: resolved planner strategy),
//   BENCH_WARM_PASS (def 1 — also run the warm pass B), BENCH_WORKER_COMPARE
//   (def 1 — also time inline-vs-worker), BENCH_OUT (JSON rows).

import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Kysely } from "kysely";
import type { Database } from "@gctp/db";
import { Tours } from "@gctp/shared";
import { AppModule } from "../../app.module.js";
import { CacheLanduseRepository } from "../../caches/cache-landuse.repository.js";
import { CachesRepository } from "../../caches/caches.repository.js";
import { CachesService } from "../../caches/caches.service.js";
import {
  COMPUTE_POOL,
  type ComputePool,
} from "../compute/compute-pool.service.js";
import { KYSELY } from "../../database/database.tokens.js";
import { OSRM_CLIENT, type OsrmClient } from "../../routing/osrm.client.js";
import { OsrmVersionService } from "../../routing/osrm-version.service.js";
import { RoutingRepository } from "../../routing/routing.repository.js";
import {
  type ContextStats,
  prepareClusteringContext,
  resolveClusteringStrategy,
} from "../strategies/greedy/clustering/index.js";
import { computeClusters } from "../strategies/greedy/discover-compute.js";
import { mean, num, stdev } from "./bench-metrics.js";
import { pickSeeds, resolveOwner } from "./corpus.js";

const log = new Logger("discovery-timing");
const clock = () => performance.now();

/** One discovery pass: phase timings + the counts that explain them. */
interface PassSample {
  ctxWallMs: number; // end-to-end around prepareClusteringContext
  listMs: number;
  landuseMs: number;
  walkingGraphMs: number;
  overFetchMs: number;
  cacheReadMs: number;
  osrmFetchMs: number;
  persistMs: number;
  rankSymmetriseMs: number;
  seedsMs: number;
  candidateCount: number;
  poolSize: number;
  origins: number;
  candidatePairs: number;
  cellsCacheHit: number;
  cellsOsrmFetched: number;
  edges: number;
  hitRatio: number; // cellsCacheHit / candidatePairs
}

function sampleFromStats(wallMs: number, s: Partial<ContextStats>): PassSample {
  const w = s.walking ?? {};
  const pairs = w.candidatePairs ?? 0;
  return {
    ctxWallMs: wallMs,
    listMs: s.listMs ?? 0,
    landuseMs: s.landuseMs ?? 0,
    walkingGraphMs: s.walkingGraphMs ?? 0,
    overFetchMs: w.overFetchMs ?? 0,
    cacheReadMs: w.cacheReadMs ?? 0,
    osrmFetchMs: w.osrmFetchMs ?? 0,
    persistMs: w.persistMs ?? 0,
    rankSymmetriseMs: w.rankSymmetriseMs ?? 0,
    seedsMs: s.seedsMs ?? 0,
    candidateCount: s.candidateCount ?? 0,
    poolSize: s.poolSize ?? 0,
    origins: w.origins ?? 0,
    candidatePairs: pairs,
    cellsCacheHit: w.cellsCacheHit ?? 0,
    cellsOsrmFetched: w.cellsOsrmFetched ?? 0,
    edges: w.edges ?? 0,
    hitRatio: pairs > 0 ? (w.cellsCacheHit ?? 0) / pairs : 1,
  };
}

interface WorkerSample {
  inlineMs: number; // pure computeClusters on the main thread
  poolMs: number; // computePool.computeClusters (clone out + back + compute)
  overheadMs: number; // poolMs − inlineMs ≈ structured-clone + dispatch
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["warn", "error"],
  });
  try {
    const db = app.get<Kysely<Database>>(KYSELY);
    const pool = app.get<ComputePool>(COMPUTE_POOL);
    const deps = {
      caches: app.get(CachesService),
      cachesRepo: app.get(CachesRepository),
      cacheLanduse: app.get(CacheLanduseRepository),
      routingRepo: app.get(RoutingRepository),
      osrm: app.get<OsrmClient>(OSRM_CLIENT),
      osrmVersion: app.get(OsrmVersionService),
      logger: log,
    };

    const ownerId = await resolveOwner(db);
    const spacing = num("BENCH_SEED_SPACING_M", 3000);
    const maxSeeds = Math.floor(num("BENCH_MAX_SEEDS", 40));
    const radiusM = Math.floor(num("BENCH_RADIUS_M", 5000));
    const budgetM = Math.floor(num("BENCH_BUDGET_M", 10000));
    const mcs = Math.floor(num("BENCH_MIN_CLUSTER_SIZE", 8));
    const link = Math.floor(num("BENCH_MAX_LINK_M", 1500));
    const warmPass = process.env.BENCH_WARM_PASS !== "0";
    const workerCompare = process.env.BENCH_WORKER_COMPARE !== "0";
    const strategy = resolveClusteringStrategy(
      process.env.BENCH_STRATEGY as Tours.ClusteringStrategyName | undefined,
      process.env.PLANNER_CLUSTERING,
    );

    const seeds = await pickSeeds(db, ownerId, spacing, maxSeeds);
    log.log(
      `owner=${ownerId} seeds=${seeds.length} radius=${radiusM} budget=${budgetM} ` +
        `strategy=${strategy.name} warmPass=${warmPass} workerCompare=${workerCompare}`,
    );

    const cold: PassSample[] = [];
    const warm: PassSample[] = [];
    const worker: WorkerSample[] = [];

    for (const [lng, lat] of seeds) {
      let planInput: Tours.PlanInput;
      try {
        planInput = Tours.PlanInput.parse({
          center: [lng, lat],
          radiusM,
          minClusterSize: mcs,
          maxLinkMeters: link,
          distanceBudgetMeters: budgetM,
          clusteringStrategy: strategy.name,
          hardFilters: {},
          softPreferences: {},
        });
      } catch (e) {
        log.warn(`seed ${lng},${lat}: bad input (${(e as Error).message})`);
        continue;
      }

      // Pass A — mostly cold (OSRM misses populate route_legs).
      const sA: Partial<ContextStats> = {};
      const tA = clock();
      const ctx = await prepareClusteringContext(
        ownerId,
        planInput,
        deps,
        sA,
      ).catch((e) => {
        log.warn(`seed ${lng},${lat}: ctx A failed (${(e as Error).message})`);
        return null;
      });
      if (!ctx || ctx.pool.length < 2) continue;
      cold.push(sampleFromStats(clock() - tA, sA));

      // Pass B — fully warm (identical context, route_legs now populated).
      if (warmPass) {
        const sB: Partial<ContextStats> = {};
        const tB = clock();
        const ctxB = await prepareClusteringContext(
          ownerId,
          planInput,
          deps,
          sB,
        ).catch(() => null);
        if (ctxB) warm.push(sampleFromStats(clock() - tB, sB));
      }

      // Worker round-trip vs the same compute inline (ADR-0014 clone cost).
      if (workerCompare) {
        try {
          const tIn = clock();
          computeClusters(ctx, strategy.name, []);
          const inlineMs = clock() - tIn;
          const tPo = clock();
          await pool.computeClusters(ctx, strategy.name, []);
          const poolMs = clock() - tPo;
          worker.push({ inlineMs, poolMs, overheadMs: poolMs - inlineMs });
        } catch (e) {
          log.warn(
            `seed ${lng},${lat}: worker compare (${(e as Error).message})`,
          );
        }
      }
    }

    report(cold, warm, worker);
    if (process.env.BENCH_OUT) {
      writeFileSync(
        process.env.BENCH_OUT,
        JSON.stringify({ cold, warm, worker }, null, 2),
      );
      log.log(`wrote raw samples to ${process.env.BENCH_OUT}`);
    }
  } finally {
    await app.close();
  }
}

function ms(xs: number[]): string {
  return `${mean(xs).toFixed(1)}±${stdev(xs).toFixed(1)}ms`;
}

/** A phase line: mean±sd and its share of the context wall-clock. */
function phaseLine(label: string, xs: number[], totalMean: number): string {
  const m = mean(xs);
  const pct = totalMean > 0 ? (m / totalMean) * 100 : 0;
  return `    ${label.padEnd(22)} ${ms(xs).padStart(16)}   ${pct.toFixed(0).padStart(3)}%`;
}

function reportPass(title: string, s: PassSample[]): void {
  if (s.length === 0) {
    console.warn(`\n▸ ${title}: no samples`);
    return;
  }
  const wall = mean(s.map((x) => x.ctxWallMs));
  console.warn(`\n▸ ${title}  (n=${s.length})`);
  console.warn(
    `    context wall-clock     ${ms(s.map((x) => x.ctxWallMs)).padStart(16)}   100%`,
  );
  console.warn(
    phaseLine(
      "├ list (DB pull)",
      s.map((x) => x.listMs),
      wall,
    ),
  );
  console.warn(
    phaseLine(
      "├ landuse",
      s.map((x) => x.landuseMs),
      wall,
    ),
  );
  console.warn(
    phaseLine(
      "├ walking-graph",
      s.map((x) => x.walkingGraphMs),
      wall,
    ),
  );
  console.warn(
    phaseLine(
      "│  ├ postgis overfetch",
      s.map((x) => x.overFetchMs),
      wall,
    ),
  );
  console.warn(
    phaseLine(
      "│  ├ route_legs read",
      s.map((x) => x.cacheReadMs),
      wall,
    ),
  );
  console.warn(
    phaseLine(
      "│  ├ OSRM /table fetch",
      s.map((x) => x.osrmFetchMs),
      wall,
    ),
  );
  console.warn(
    phaseLine(
      "│  ├ persist",
      s.map((x) => x.persistMs),
      wall,
    ),
  );
  console.warn(
    phaseLine(
      "│  └ rank+symmetrise",
      s.map((x) => x.rankSymmetriseMs),
      wall,
    ),
  );
  console.warn(
    phaseLine(
      "└ seeds",
      s.map((x) => x.seedsMs),
      wall,
    ),
  );
  console.warn(
    `    pool ${mean(s.map((x) => x.poolSize)).toFixed(0)} caches (of ${mean(s.map((x) => x.candidateCount)).toFixed(0)} cand), ` +
      `${mean(s.map((x) => x.origins)).toFixed(0)} origins, ` +
      `${mean(s.map((x) => x.candidatePairs)).toFixed(0)} pairs, ` +
      `${mean(s.map((x) => x.edges)).toFixed(0)} edges`,
  );
  console.warn(
    `    cache-hit ${(mean(s.map((x) => x.hitRatio)) * 100).toFixed(0)}% ` +
      `(${mean(s.map((x) => x.cellsCacheHit)).toFixed(0)} hit / ${mean(s.map((x) => x.cellsOsrmFetched)).toFixed(0)} OSRM-fetched per discovery)`,
  );
}

function report(
  cold: PassSample[],
  warm: PassSample[],
  worker: WorkerSample[],
): void {
  console.warn(
    "\n════════════ discovery timing — phase attribution ════════════",
  );
  reportPass("PASS A (cold — populates route_legs)", cold);
  if (warm.length) reportPass("PASS B (warm — route_legs hits)", warm);

  if (warm.length && cold.length) {
    const dOsrm =
      mean(cold.map((x) => x.osrmFetchMs)) -
      mean(warm.map((x) => x.osrmFetchMs));
    const dWall =
      mean(cold.map((x) => x.ctxWallMs)) - mean(warm.map((x) => x.ctxWallMs));
    console.warn(
      `\n▸ COLD→WARM delta: OSRM /table ${dOsrm.toFixed(0)}ms saved, ` +
        `context wall ${dWall.toFixed(0)}ms saved ` +
        `— this is the precompute / cache-hit-rate prize.`,
    );
  }

  if (worker.length) {
    console.warn(`\n▸ WORKER round-trip (ADR-0014)  (n=${worker.length})`);
    console.warn(
      `    inline compute         ${ms(worker.map((x) => x.inlineMs)).padStart(16)}`,
    );
    console.warn(
      `    pool round-trip        ${ms(worker.map((x) => x.poolMs)).padStart(16)}`,
    );
    console.warn(
      `    clone+dispatch overhead${ms(worker.map((x) => x.overheadMs)).padStart(16)}   ← structured-clone of ctx out + result back`,
    );
  }

  console.warn(
    "\nReal discovery = context wall-clock + worker pool round-trip. Read the " +
      "biggest %-of-wall row above and pull THAT lever — don't assume which " +
      "phase dominates (profiling showed the PostGIS over-fetch, not OSRM, was " +
      "the original cost). Levers per phase in docs/PLANNER_TUNING.md.",
  );
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
