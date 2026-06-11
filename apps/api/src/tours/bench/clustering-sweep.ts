// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Clustering-strategy sweep: build the Pass-1 walking-graph context ONCE per
// seed (real OSRM + DB) and run every registered clustering strategy on that
// identical context, so the comparison is apples-to-apples (no per-strategy
// OSRM/DB re-work). For each strategy we run `cluster()` + the shared
// `refineClusters` pipeline — exactly what the planner ships — and score the
// resulting candidate clusters on the axes that matter for a walkable loop:
// coverage, size, tightness (MST metres per cache) and budget fit.
//
// This is the offline batch form of the `POST /tours/clusters/explain` harness:
// same strategy registry, same refinement, same Jaccard — just swept across
// many real seeds instead of one user selection, with no auth.
//
// Run inside the api container (after `docker compose build api`):
//   docker compose exec api node dist/tours/bench/clustering-sweep.js
//
// Env (shared with the other bench tools):
//   BENCH_OWNER_ID, BENCH_CENTER ("lng,lat"), BENCH_AREA_RADIUS_M,
//   BENCH_SEED_SPACING_M, BENCH_MAX_SEEDS, BENCH_RADIUS_M,
//   BENCH_BUDGET_M (distance budget), BENCH_MIN_CLUSTER_SIZE, BENCH_MAX_LINK_M.
//   BENCH_OUT — optional path; when set, writes the per-strategy rows as JSON.

import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { type Kysely } from "kysely";
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
import type { ClusteringContext } from "../strategies/greedy/clustering/strategy.js";
import { haversineMeters } from "../strategies/greedy/equirectangular.js";
import { jaccard, mean, median, num } from "./bench-metrics.js";
import { pickSeeds, resolveOwner } from "./corpus.js";

const log = new Logger("clustering-sweep");

/** Per-strategy accumulators across all seeds. */
interface StrategyAcc {
  seeds: number; // seeds where this strategy produced ≥1 refined cluster
  rawClusters: number; // pre-refinement candidate count
  clusters: number; // post-refinement candidate count
  sizes: number[]; // refined cluster sizes
  coverage: number[]; // per-seed fraction of pool assigned to a cluster
  tightness: number[]; // per-cluster MST metres / cache
  budgetOk: number; // refined clusters with MST×2 ≤ budget
  wallMs: number[]; // per-seed cluster()+refine wall time
}

function emptyAcc(): StrategyAcc {
  return {
    seeds: 0,
    rawClusters: 0,
    clusters: 0,
    sizes: [],
    coverage: [],
    tightness: [],
    budgetOk: 0,
    wallMs: [],
  };
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["warn", "error"],
  });
  try {
    const db = app.get<Kysely<Database>>(KYSELY);
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
    const spacing = num("BENCH_SEED_SPACING_M", 4000);
    const maxSeeds = Math.floor(num("BENCH_MAX_SEEDS", 30));
    const radiusM = Math.floor(num("BENCH_RADIUS_M", 5000));
    const budgetM = Math.floor(num("BENCH_BUDGET_M", 12000));
    const minClusterSize = Math.floor(num("BENCH_MIN_CLUSTER_SIZE", 8));
    const maxLinkM = Math.floor(num("BENCH_MAX_LINK_M", 1500));

    const seeds = await pickSeeds(db, ownerId, spacing, maxSeeds);
    log.log(
      `owner=${ownerId} seeds=${seeds.length} radius=${radiusM} ` +
        `minClusterSize=${minClusterSize} maxLink=${maxLinkM} budget=${budgetM}`,
    );

    const names = Object.keys(CLUSTERING_STRATEGIES);
    const acc = new Map<string, StrategyAcc>(names.map((n) => [n, emptyAcc()]));
    let contexts = 0;
    // Direct hdbscan ↔ hdbscan-star agreement, measured on the FINAL (refined)
    // clusters: for every star cluster, its best Jaccard against any legacy
    // cluster. 1.0 everywhere ⇒ the strategies are indistinguishable downstream.
    const starBestJaccard: number[] = [];
    let starClustersIdentical = 0;
    let starClustersTotal = 0;

    for (const [lng, lat] of seeds) {
      let ctx: ClusteringContext | null = null;
      try {
        const planInput = Tours.PlanInput.parse({
          center: [lng, lat],
          radiusM,
          minClusterSize,
          maxLinkMeters: maxLinkM,
          distanceBudgetMeters: budgetM,
          hardFilters: {},
          softPreferences: {},
        });
        ctx = await prepareClusteringContext(ownerId, planInput, deps);
      } catch (e) {
        log.warn(
          `seed ${lng},${lat}: context build failed (${(e as Error).message})`,
        );
        continue;
      }
      if (!ctx || ctx.pool.length < 2) continue;
      contexts += 1;
      const poolSize = ctx.pool.length;
      const coordById = new Map(
        ctx.pool.map((c) => [
          c.id,
          [c.location.coordinates[0]!, c.location.coordinates[1]!] as const,
        ]),
      );

      const refinedByName = new Map<string, number[][]>();
      for (const [name, strategy] of Object.entries(CLUSTERING_STRATEGIES)) {
        const a = acc.get(name)!;
        const t0 = Date.now();
        const raw = strategy.cluster(ctx);
        const refined = refineClusters(raw, ctx, strategy.skipRefinement);
        a.wallMs.push(Date.now() - t0);
        a.rawClusters += raw.length;
        a.clusters += refined.length;
        if (refined.length > 0) a.seeds += 1;
        refinedByName.set(name, refined);

        const assigned = new Set<number>();
        for (const cluster of refined) {
          a.sizes.push(cluster.length);
          for (const id of cluster) assigned.add(id);
          const mst = mstMeters(cluster, coordById);
          a.tightness.push(mst / cluster.length);
          if (mst * 2 <= budgetM) a.budgetOk += 1;
        }
        a.coverage.push(assigned.size / poolSize);
      }

      // hdbscan ↔ hdbscan-star agreement on this seed's refined clusters.
      const legacy = refinedByName.get("hdbscan") ?? [];
      const star = refinedByName.get("hdbscan-star") ?? [];
      for (const sc of star) {
        let bestJ = 0;
        for (const lc of legacy) bestJ = Math.max(bestJ, jaccard(sc, lc));
        starBestJaccard.push(bestJ);
        starClustersTotal += 1;
        if (bestJ === 1) starClustersIdentical += 1;
      }
    }

    report(acc, contexts, budgetM, {
      meanBestJaccard: mean(starBestJaccard),
      identicalPct:
        starClustersTotal > 0
          ? (starClustersIdentical / starClustersTotal) * 100
          : 0,
      starClustersTotal,
    });
    maybeWriteJson(acc);
  } finally {
    await app.close();
  }
}

/** Haversine MST length (Prim) over a cluster's cache coordinates. */
function mstMeters(
  cacheIds: readonly number[],
  coordById: ReadonlyMap<number, readonly [number, number]>,
): number {
  const pts = cacheIds
    .map((id) => coordById.get(id))
    .filter((p): p is readonly [number, number] => p !== undefined);
  const n = pts.length;
  if (n <= 1) return 0;
  const inTree = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  best[0] = 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    let u = -1;
    let bd = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j += 1) {
      if (!inTree[j] && best[j]! < bd) {
        bd = best[j]!;
        u = j;
      }
    }
    if (u < 0) break;
    inTree[u] = true;
    if (Number.isFinite(bd)) total += bd;
    for (let v = 0; v < n; v += 1) {
      if (inTree[v]) continue;
      const d = haversineMeters(pts[u]!, pts[v]!);
      if (d < best[v]!) best[v] = d;
    }
  }
  return total;
}

function report(
  acc: ReadonlyMap<string, StrategyAcc>,
  contexts: number,
  budgetM: number,
  agreement: {
    meanBestJaccard: number;
    identicalPct: number;
    starClustersTotal: number;
  },
): void {
  console.warn(
    "\n══════════════════════ clustering strategy sweep ══════════════════════",
  );
  console.warn(
    `contexts=${contexts}  (one shared walking graph per seed; budget=${budgetM} m)\n`,
  );
  const head =
    "strategy        seeds  raw   cl  size(mn/md)  cover%  tight(m/c)  bud%   ms";
  console.warn(head);
  console.warn("─".repeat(head.length));
  for (const [name, a] of acc) {
    const sizeMn = mean(a.sizes);
    const sizeMd = median(a.sizes);
    const cover = mean(a.coverage) * 100;
    const tight = median(a.tightness);
    const budPct = a.clusters > 0 ? (a.budgetOk / a.clusters) * 100 : 0;
    console.warn(
      `${pad(name, 14)}  ${pad(String(a.seeds), 4)}  ${pad(String(a.rawClusters), 4)} ${pad(String(a.clusters), 4)}  ` +
        `${pad(sizeMn.toFixed(1), 4)}/${pad(sizeMd.toFixed(0), 3)}   ${pad(cover.toFixed(0), 5)}   ${pad(tight.toFixed(0), 7)}  ` +
        `${pad(budPct.toFixed(0), 4)}  ${pad(mean(a.wallMs).toFixed(0), 4)}`,
    );
  }
  console.warn(
    "\nLegend: raw=pre-refine candidates · cl=post-refine candidates · " +
      "size=caches per cluster (mean/median) · cover=% of pool assigned · " +
      "tight=median MST metres per cache (lower=denser) · " +
      "bud=% clusters with MST×2 ≤ budget · ms=mean cluster()+refine per seed.",
  );

  // Head-to-head: the legacy bisection vs true HDBSCAN*.
  const h = acc.get("hdbscan");
  const hs = acc.get("hdbscan-star");
  if (h && hs) {
    console.warn("\n── hdbscan (bisection) vs hdbscan-star (stability) ──");
    console.warn(
      `  clusters returned     : ${h.clusters}  →  ${hs.clusters}  (${delta(h.clusters, hs.clusters)})`,
    );
    console.warn(
      `  mean cluster size     : ${mean(h.sizes).toFixed(1)}  →  ${mean(hs.sizes).toFixed(1)}  (${delta(mean(h.sizes), mean(hs.sizes))})`,
    );
    console.warn(
      `  coverage %            : ${(mean(h.coverage) * 100).toFixed(0)}  →  ${(mean(hs.coverage) * 100).toFixed(0)}`,
    );
    console.warn(
      `  median tightness m/c  : ${median(h.tightness).toFixed(0)}  →  ${median(hs.tightness).toFixed(0)}`,
    );
    console.warn(
      `  raw (pre-refine)      : ${h.rawClusters}  →  ${hs.rawClusters}  (${delta(h.rawClusters, hs.rawClusters)})  ← where the algorithms actually differ`,
    );
    console.warn(
      `  final-cluster agreement: mean best-Jaccard ${agreement.meanBestJaccard.toFixed(3)}, ` +
        `${agreement.identicalPct.toFixed(0)}% of ${agreement.starClustersTotal} star clusters identical to a legacy one`,
    );
    console.warn(
      "  (High agreement ⇒ the shared refinement pipeline normalises the raw difference;\n" +
        "   the algorithm swap moves final candidates little on this data/params.)",
    );
  }
}

function delta(from: number, to: number): string {
  if (from === 0) return "n/a";
  const pct = ((to - from) / from) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function maybeWriteJson(acc: ReadonlyMap<string, StrategyAcc>): void {
  const out = process.env.BENCH_OUT;
  if (!out) return;
  const rows = [...acc.entries()].map(([strategy, a]) => ({
    strategy,
    seedsWithClusters: a.seeds,
    rawClusters: a.rawClusters,
    clusters: a.clusters,
    meanSize: mean(a.sizes),
    medianSize: median(a.sizes),
    coveragePct: mean(a.coverage) * 100,
    medianTightnessMPerCache: median(a.tightness),
    budgetOkPct: a.clusters > 0 ? (a.budgetOk / a.clusters) * 100 : 0,
    meanWallMs: mean(a.wallMs),
  }));
  writeFileSync(out, JSON.stringify(rows, null, 2));
  log.log(`wrote ${rows.length} rows → ${out}`);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
