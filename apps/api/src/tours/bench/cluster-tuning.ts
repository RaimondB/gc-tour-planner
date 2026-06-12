// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cluster-tuning lab: find the best DISCOVERY defaults for a target route
// budget. Unlike clustering-sweep (Pass-1 quality only), this runs the full
// pipeline — discover (Pass 1) → route (Pass 2 planLoop) — so it measures what
// actually matters: how many caches land in the routed loop, whether the loop
// stays within budget, and how much fringe (dropped caches + realised retrace)
// it carries.
//
// Discovery is run INLINE (prepareClusteringContext + strategy.cluster +
// refineClusters), not via planner.discoverClusters — the latter dispatches to
// the piscina worker pool, whose payload can't structured-clone the projection
// closure. Inline also lets us build the walking-graph context once per seed and
// reuse it across every strategy at the same maxLink (apples-to-apples, cheap).
//
// For each discovery config (clustering strategy × minClusterSize × maxLink) it
// discovers clusters across the WHOLE owner dataset (many seeds, deduped),
// routes each at the budget, and reports the cluster-size and tour-cache
// distributions (mean ± sd [min..max]), %-within-budget, and fringe. Ranked by
// mean caches-in-loop (the "pack the budget" objective), with fringe shown.
//
// Symmetry (PLANNER_KNN_SYMMETRY) and the mutual floor are read once at process
// start, so A/B them by running the whole bench under different -e values.
//
// Run inside the api container:
//   docker compose exec -e BENCH_BUDGET_M=10000 -e BENCH_MAX_SEEDS=200 \
//     api node dist/tours/bench/cluster-tuning.js
//
// Env: BENCH_OWNER_ID, BENCH_CENTER, BENCH_AREA_RADIUS_M, BENCH_SEED_SPACING_M,
//   BENCH_MAX_SEEDS, BENCH_RADIUS_M, BENCH_BUDGET_M (target route budget, def
//   10000), BENCH_MAX_CLUSTERS (cap routed/config), BENCH_MIN_CLUSTER_SIZE,
//   BENCH_MAX_LINK_M, BENCH_CONFIGS (JSON override), BENCH_OUT (JSON rows).

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
import { KYSELY } from "../../database/database.tokens.js";
import { OSRM_CLIENT, type OsrmClient } from "../../routing/osrm.client.js";
import { OsrmVersionService } from "../../routing/osrm-version.service.js";
import { RoutingRepository } from "../../routing/routing.repository.js";
import {
  CLUSTERING_STRATEGIES,
  prepareClusteringContext,
  refineClusters,
} from "../strategies/greedy/clustering/index.js";
import {
  histogram,
  maxOf,
  mean,
  minOf,
  num,
  pctWhere,
  realisedRetraceMeters,
  stdev,
} from "./bench-metrics.js";
import { pickSeeds, resolveOwner } from "./corpus.js";

const RETRACE_GRID_M = 25;
const LOOP_CACHE_CAP = 50; // PlanLoopInput.cacheIds max (= Pass-2 MAX_LOOP_CACHES)

interface TuneConfig {
  label: string;
  strategy: Tours.ClusteringStrategyName;
  minClusterSize: number;
  maxLinkMeters: number;
  geoTrimFactor?: number; // override geographic-trim median multiplier (def 2)
  geoTrimCapFrac?: number; // override absolute cap = budget × frac (def 0.25)
}

interface ConfigResult {
  cfg: TuneConfig;
  rawSizes: number[]; // strategy.cluster() size, BEFORE refinement
  sizes: number[]; // refined cluster size (pre-route)
  tourCaches: number[]; // caches in the routed loop
  routedKm: number[];
  dropped: number[]; // fringe: caches trimmed by Pass-2
  retrace: number[]; // fringe: realised retrace metres
  capped: number; // clusters whose size exceeded the 50 loop cap
  kept: Set<number>[]; // cross-seed dedup
}

const log = new Logger("cluster-tuning");

function loadConfigs(mcs: number, link: number): TuneConfig[] {
  const raw = process.env.BENCH_CONFIGS;
  if (raw) {
    return (
      JSON.parse(raw) as Array<Partial<TuneConfig> & { strategy: string }>
    ).map((c) => ({
      label: c.label ?? c.strategy,
      strategy: c.strategy as Tours.ClusteringStrategyName,
      minClusterSize: c.minClusterSize ?? mcs,
      maxLinkMeters: c.maxLinkMeters ?? link,
      geoTrimFactor: c.geoTrimFactor,
      geoTrimCapFrac: c.geoTrimCapFrac,
    }));
  }
  const strategies: Tours.ClusteringStrategyName[] = [
    "louvain",
    "leiden",
    "dbscan",
    "hdbscan",
    "hdbscan-star",
    "components",
  ];
  return strategies.map((s) => ({
    label: s,
    strategy: s,
    minClusterSize: mcs,
    maxLinkMeters: link,
  }));
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["warn", "error"],
  });
  try {
    const db = app.get<Kysely<Database>>(KYSELY);
    const planner = app.get<Tours.TourPlannerStrategy>(Tours.TOUR_PLANNER);
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
    const maxSeeds = Math.floor(num("BENCH_MAX_SEEDS", 200));
    const radiusM = Math.floor(num("BENCH_RADIUS_M", 5000));
    const budgetM = Math.floor(num("BENCH_BUDGET_M", 10000));
    const maxClusters = Math.floor(num("BENCH_MAX_CLUSTERS", 400));
    const mcs = Math.floor(num("BENCH_MIN_CLUSTER_SIZE", 8));
    const link = Math.floor(num("BENCH_MAX_LINK_M", 1500));
    const symmetry =
      process.env.PLANNER_KNN_SYMMETRY === "mutual" ? "mutual" : "or";

    const seeds = await pickSeeds(db, ownerId, spacing, maxSeeds);
    const configs = loadConfigs(mcs, link);
    log.log(
      `owner=${ownerId} seeds=${seeds.length} budget=${budgetM} symmetry=${symmetry} ` +
        `configs=${configs.length} (cap ${maxClusters} routed/config)`,
    );

    const results = new Map<string, ConfigResult>(
      configs.map((cfg) => [
        cfg.label,
        {
          cfg,
          rawSizes: [],
          sizes: [],
          tourCaches: [],
          routedKm: [],
          dropped: [],
          retrace: [],
          capped: 0,
          kept: [],
        },
      ]),
    );

    // Group configs by maxLink: the walking graph (hence context) only depends
    // on maxLink, so build it once per (seed, link) and reuse across strategies
    // and minClusterSize values.
    const links = [...new Set(configs.map((c) => c.maxLinkMeters))];
    for (const lk of links) {
      const cfgs = configs.filter((c) => c.maxLinkMeters === lk);
      for (const [lng, lat] of seeds) {
        if (cfgs.every((c) => results.get(c.label)!.kept.length >= maxClusters))
          continue;
        let ctx;
        try {
          const planInput = Tours.PlanInput.parse({
            center: [lng, lat],
            radiusM,
            minClusterSize: mcs,
            maxLinkMeters: lk,
            distanceBudgetMeters: budgetM,
            hardFilters: {},
            softPreferences: {},
          });
          ctx = await prepareClusteringContext(ownerId, planInput, deps);
        } catch (e) {
          log.warn(`ctx @ ${lng},${lat} link=${lk}: ${(e as Error).message}`);
          continue;
        }
        if (!ctx || ctx.pool.length < 2) continue;

        for (const cfg of cfgs) {
          const r = results.get(cfg.label)!;
          if (r.kept.length >= maxClusters) continue;
          const cctx = {
            ...ctx,
            input: { ...ctx.input, minClusterSize: cfg.minClusterSize },
          };
          const strategy = CLUSTERING_STRATEGIES[cfg.strategy];
          const raw = strategy.cluster(cctx);
          for (const rc of raw) {
            if (rc.cacheIds.length >= 2) r.rawSizes.push(rc.cacheIds.length);
          }
          const refined = refineClusters(raw, cctx, strategy.skipRefinement, {
            geoTrimFactor: cfg.geoTrimFactor,
            geoTrimCapFrac: cfg.geoTrimCapFrac,
          });
          for (const cluster of refined) {
            if (r.kept.length >= maxClusters) break;
            if (cluster.length < 2) continue;
            const set = new Set(cluster);
            if (r.kept.some((k) => jaccardSets(k, set) > 0.5)) continue;
            r.kept.push(set);
            await routeCluster(planner, ownerId, cluster, cfg, budgetM, r);
          }
        }
      }
    }

    report([...results.values()], budgetM, symmetry);
    if (process.env.BENCH_OUT) {
      writeFileSync(
        process.env.BENCH_OUT,
        JSON.stringify(toRows([...results.values()]), null, 2),
      );
      log.log(`wrote ${results.size} config rows to ${process.env.BENCH_OUT}`);
    }
  } finally {
    await app.close();
  }
}

async function routeCluster(
  planner: Tours.TourPlannerStrategy,
  ownerId: string,
  cluster: readonly number[],
  cfg: TuneConfig,
  budgetM: number,
  r: ConfigResult,
): Promise<void> {
  if (cluster.length > LOOP_CACHE_CAP) r.capped += 1;
  const ids = cluster.slice(0, LOOP_CACHE_CAP);
  try {
    const loopInput = Tours.PlanLoopInput.parse({
      cacheIds: ids,
      distanceBudgetMeters: budgetM,
      maxLinkMeters: cfg.maxLinkMeters,
    });
    const res = await planner.planLoop(ownerId, loopInput);
    r.sizes.push(cluster.length);
    r.tourCaches.push(res.orderedCacheIds.length);
    r.routedKm.push(res.totals.meters / 1000);
    r.dropped.push(res.droppedCacheIds.length);
    r.retrace.push(realisedRetraceMeters(res.polyline, RETRACE_GRID_M));
  } catch (e) {
    log.warn(`${cfg.label}: plan failed (${(e as Error).message})`);
  }
}

function jaccardSets(a: Set<number>, b: Set<number>): number {
  let inter = 0;
  for (const x of b) if (a.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function dist(xs: number[]): string {
  return `${mean(xs).toFixed(1)}±${stdev(xs).toFixed(1)} [${minOf(xs).toFixed(0)}..${maxOf(xs).toFixed(0)}]`;
}

/** "size:count" pairs, e.g. `8:12 9:9 10:7 …` — the Pareto histogram. */
function histLine(xs: number[]): string {
  return Object.entries(histogram(xs))
    .map(([size, count]) => `${size}:${count}`)
    .join(" ");
}

function report(
  results: ConfigResult[],
  budgetM: number,
  symmetry: string,
): void {
  const budgetKm = budgetM / 1000;
  // Rank by caches packed into a within-budget loop; fringe breaks ties.
  const ranked = [...results].sort((a, b) => {
    const d = mean(b.tourCaches) - mean(a.tourCaches);
    if (Math.abs(d) > 0.05) return d;
    return (
      mean(a.retrace) +
      mean(a.dropped) * 50 -
      (mean(b.retrace) + mean(b.dropped) * 50)
    );
  });

  console.warn(
    `\n════════════ cluster tuning — budget ${budgetKm}km, symmetry=${symmetry} ════════════`,
  );
  for (const r of ranked) {
    console.warn(
      `\n▸ ${r.cfg.label}  (minClusterSize=${r.cfg.minClusterSize}, maxLink=${r.cfg.maxLinkMeters}, geoTrimFactor=${r.cfg.geoTrimFactor ?? "def"}, capFrac=${r.cfg.geoTrimCapFrac ?? "def"})`,
    );
    console.warn(
      `    clusters routed   : ${r.tourCaches.length}${r.capped ? ` (${r.capped} hit 50-cap)` : ""}`,
    );
    console.warn(
      `    raw size (pre-refine): ${dist(r.rawSizes)}   hist ${histLine(r.rawSizes)}`,
    );
    console.warn(
      `    cluster size       : ${dist(r.sizes)}   (${pctWhere(r.sizes, (x) => x >= 13).toFixed(0)}% ≥13, ${pctWhere(r.sizes, (x) => x >= 16).toFixed(0)}% ≥16)`,
    );
    console.warn(`    size histogram     : ${histLine(r.sizes)}`);
    console.warn(
      `    caches in loop     : ${dist(r.tourCaches)}   ← pack-the-budget`,
    );
    console.warn(
      `    routed loop km     : ${dist(r.routedKm)}   (${pctWhere(r.routedKm, (x) => x <= budgetKm + 0.001).toFixed(0)}% ≤ ${budgetKm}km)`,
    );
    console.warn(
      `    fringe: dropped    : ${mean(r.dropped).toFixed(2)}/loop   retrace ${mean(r.retrace).toFixed(0)}m`,
    );
  }
  console.warn(
    `\nRanked by mean caches-in-loop (then least fringe). "caches in loop" is the routed tour size after fringe trim; cluster size is pre-route.`,
  );
}

function toRows(results: ConfigResult[]): Record<string, unknown>[] {
  return results.map((r) => ({
    label: r.cfg.label,
    strategy: r.cfg.strategy,
    minClusterSize: r.cfg.minClusterSize,
    maxLinkMeters: r.cfg.maxLinkMeters,
    n: r.tourCaches.length,
    capped: r.capped,
    rawClusterSize: {
      mean: mean(r.rawSizes),
      sd: stdev(r.rawSizes),
      min: minOf(r.rawSizes),
      max: maxOf(r.rawSizes),
      histogram: histogram(r.rawSizes),
    },
    clusterSize: {
      mean: mean(r.sizes),
      sd: stdev(r.sizes),
      min: minOf(r.sizes),
      max: maxOf(r.sizes),
      pctGte13: pctWhere(r.sizes, (x) => x >= 13),
      pctGte16: pctWhere(r.sizes, (x) => x >= 16),
      histogram: histogram(r.sizes),
    },
    cachesInLoop: {
      mean: mean(r.tourCaches),
      sd: stdev(r.tourCaches),
      min: minOf(r.tourCaches),
      max: maxOf(r.tourCaches),
      histogram: histogram(r.tourCaches),
    },
    routedKm: { mean: mean(r.routedKm), sd: stdev(r.routedKm) },
    meanDropped: mean(r.dropped),
    meanRetraceM: mean(r.retrace),
  }));
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
