// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Benchmark: shortest vs low-overlap loop objective (ADR-0024 / FR-T12).
//
// Discovers a batch of real clusters for the cache-owning user, plans each one
// with BOTH objectives, and reports tour-quality + speed deltas so we can tell
// whether `low-overlap` actually improves anything and by how much.
//
// The headline quality metric is REALISED RETRACE — measured on the actual OSRM
// polyline (how many extra times the route re-enters a 25 m grid cell), NOT the
// straight-line proxy the solver optimises. That keeps the evaluation honest:
// the proxy is the lever, the realised geometry is the outcome.
//
// Runs as a headless Nest application context — same planner, DB, OSRM, and
// worker pool the API uses, no HTTP server and no auth guard. Run it INSIDE the
// api container so DB/OSRM/Valkey env + the compiled worker resolve correctly:
//
//   docker compose exec api node dist/tours/bench/loop-objective-bench.js
//
// Env knobs (all optional):
//   BENCH_OWNER_ID    owner uuid to plan for (default: the owner with most caches)
//   BENCH_CLUSTERS    how many cluster seeds to evaluate           (default 12)
//   BENCH_RADIUS_M    discovery radius around each seed            (default 5000)
//   BENCH_MAX_CACHES  maxCaches per cluster                        (default 20)
//   BENCH_BUDGET_M    distanceBudgetMeters                         (default 12000)
//   BENCH_BETA        PLANNER_LOOP_ORDER_BETA override for the run (default: env/0.8)
//   BENCH_OUT         write full JSON results here                 (default: skip)

import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { sql, type Kysely } from "kysely";
import type { Database } from "@gctp/db";
import { Tours } from "@gctp/shared";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { AppModule } from "../../app.module.js";
import { KYSELY } from "../../database/database.tokens.js";
import {
  arrEq,
  mean,
  median,
  num,
  realisedRetraceMeters,
} from "./bench-metrics.js";

const OBJECTIVES = ["shortest", "low-overlap"] as const;
type Objective = (typeof OBJECTIVES)[number];

interface PlanMetrics {
  meters: number;
  seconds: number;
  visited: number;
  dropped: number;
  /** Realised retrace (m): extra route length re-entering an already-walked cell. */
  retraceM: number;
  /** Wall-clock of the planLoop call (ms). */
  wallMs: number;
  order: number[];
}

interface ClusterRow {
  seedCacheId: number;
  clusterSize: number;
  shortest: PlanMetrics;
  lowOverlap: PlanMetrics;
  orderChanged: boolean;
}

async function main(): Promise<void> {
  if (process.env.BENCH_BETA) process.env.PLANNER_LOOP_ORDER_BETA = process.env.BENCH_BETA;
  const log = new Logger("loop-bench");
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["warn", "error"],
  });
  try {
    const db = app.get<Kysely<Database>>(KYSELY);
    const planner = app.get<Tours.TourPlannerStrategy>(Tours.TOUR_PLANNER);

    const nClusters = Math.floor(num("BENCH_CLUSTERS", 12));
    const radiusM = Math.floor(num("BENCH_RADIUS_M", 5000));
    const maxCaches = Math.floor(num("BENCH_MAX_CACHES", 20));
    const budgetM = Math.floor(num("BENCH_BUDGET_M", 12000));

    // Resolve the owner to plan for: explicit, else the user with most caches.
    let ownerId = process.env.BENCH_OWNER_ID ?? "";
    if (!ownerId) {
      const top = await db
        .selectFrom("caches")
        .select(["owner_id"])
        .where("owner_id", "is not", null)
        .groupBy("owner_id")
        .orderBy(sql`count(*)`, "desc")
        .limit(1)
        .executeTakeFirst();
      if (!top?.owner_id) throw new Error("no owned caches found in this database");
      ownerId = top.owner_id;
    }

    // Deterministic pseudo-random spread of seed caches across the owner's set.
    const seeds = await db
      .selectFrom("caches")
      .select([
        "id",
        sql<number>`ST_X(location::geometry)`.as("lng"),
        sql<number>`ST_Y(location::geometry)`.as("lat"),
      ])
      .where("owner_id", "=", ownerId)
      .orderBy(sql`md5(id::text)`)
      .limit(nClusters)
      .execute();

    log.log(
      `owner=${ownerId} seeds=${seeds.length} radius=${radiusM}m maxCaches=${maxCaches} budget=${budgetM}m beta=${process.env.PLANNER_LOOP_ORDER_BETA ?? "0.8"}`,
    );

    const rows: ClusterRow[] = [];
    for (const seed of seeds) {
      let candidate: Tours.ClusterCandidate | undefined;
      try {
        const planInput = Tours.PlanInput.parse({
          center: [seed.lng, seed.lat],
          radiusM,
          maxCaches,
          distanceBudgetMeters: budgetM,
          hardFilters: {},
          softPreferences: {},
          topNClusters: 1,
        });
        const discovered = await planner.discoverClusters(ownerId, planInput);
        candidate = discovered.candidates[0];
      } catch (e) {
        log.warn(`seed ${seed.id}: discovery failed (${(e as Error).message})`);
        continue;
      }
      if (!candidate || candidate.cacheIds.length < 2) continue;

      const metrics: Partial<Record<Objective, PlanMetrics>> = {};
      let failed = false;
      for (const objective of OBJECTIVES) {
        try {
          const loopInput = Tours.PlanLoopInput.parse({
            cacheIds: candidate.cacheIds,
            distanceBudgetMeters: budgetM,
            loopObjective: objective,
          });
          const t0 = performance.now();
          const res = await planner.planLoop(ownerId, loopInput);
          const wallMs = performance.now() - t0;
          metrics[objective] = {
            meters: res.totals.meters,
            seconds: res.totals.seconds,
            visited: res.orderedCacheIds.length,
            dropped: res.droppedCacheIds.length,
            retraceM: realisedRetraceMeters(res.polyline, 25),
            wallMs,
            order: res.orderedCacheIds,
          };
        } catch (e) {
          log.warn(`seed ${seed.id} ${objective}: plan failed (${(e as Error).message})`);
          failed = true;
          break;
        }
      }
      if (failed || !metrics.shortest || !metrics["low-overlap"]) continue;

      rows.push({
        seedCacheId: seed.id,
        clusterSize: candidate.cacheIds.length,
        shortest: metrics.shortest,
        lowOverlap: metrics["low-overlap"],
        orderChanged: !arrEq(metrics.shortest.order, metrics["low-overlap"].order),
      });
      const r = rows[rows.length - 1]!;
      log.log(
        `cluster@${seed.id} size=${r.clusterSize} ` +
          `changed=${r.orderChanged ? "yes" : "no"} ` +
          `retrace ${Math.round(r.shortest.retraceM)}→${Math.round(r.lowOverlap.retraceM)}m ` +
          `dist ${Math.round(r.shortest.meters)}→${Math.round(r.lowOverlap.meters)}m ` +
          `wall ${Math.round(r.shortest.wallMs)}→${Math.round(r.lowOverlap.wallMs)}ms`,
      );
    }

    report(rows);
    if (process.env.BENCH_OUT) {
      writeFileSync(process.env.BENCH_OUT, JSON.stringify(rows, null, 2));
      log.log(`wrote ${rows.length} rows to ${process.env.BENCH_OUT}`);
    }
  } finally {
    await app.close();
  }
}

function report(rows: ClusterRow[]): void {
  if (rows.length === 0) {
    console.warn("\nNo comparable clusters — nothing to report.");
    return;
  }
  const dRetrace = rows.map((r) => r.lowOverlap.retraceM - r.shortest.retraceM);
  const dDist = rows.map((r) => r.lowOverlap.meters - r.shortest.meters);
  const dSecs = rows.map((r) => r.lowOverlap.seconds - r.shortest.seconds);
  const dWall = rows.map((r) => r.lowOverlap.wallMs - r.shortest.wallMs);
  const changed = rows.filter((r) => r.orderChanged).length;
  // Win = low-overlap retraces meaningfully less (>1 m); loss = more; else tie.
  const wins = dRetrace.filter((d) => d < -1).length;
  const losses = dRetrace.filter((d) => d > 1).length;
  const ties = rows.length - wins - losses;

  const pct = (v: number, base: number): string =>
    base > 0 ? `${((v / base) * 100).toFixed(1)}%` : "n/a";
  const baseRetrace = mean(rows.map((r) => r.shortest.retraceM));
  const baseDist = mean(rows.map((r) => r.shortest.meters));

  console.warn("\n══════════ low-overlap vs shortest ══════════");
  console.warn(`clusters compared : ${rows.length}`);
  console.warn(`order changed     : ${changed}/${rows.length}`);
  console.warn(`retrace win/tie/loss: ${wins}/${ties}/${losses}`);
  console.warn(
    `Δ realised retrace : mean ${mean(dRetrace).toFixed(0)}m  median ${median(dRetrace).toFixed(0)}m  (${pct(mean(dRetrace), baseRetrace)} of baseline ${baseRetrace.toFixed(0)}m)`,
  );
  console.warn(
    `Δ distance         : mean ${mean(dDist).toFixed(0)}m  median ${median(dDist).toFixed(0)}m  (${pct(mean(dDist), baseDist)} of baseline ${baseDist.toFixed(0)}m)`,
  );
  console.warn(`Δ time             : mean ${(mean(dSecs) / 60).toFixed(1)}min`);
  console.warn(
    `Δ plan wall-clock  : mean ${mean(dWall).toFixed(0)}ms  median ${median(dWall).toFixed(0)}ms`,
  );
  console.warn("(negative Δretrace / Δdistance = low-overlap is better / shorter)");
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
