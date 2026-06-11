// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A/B impact measurement for boundary-spanning clusters (ADR-0026). For each
// seed it runs Pass-1 discovery twice — current (PLANNER_CLUSTER_GROW off) and
// boundary-spanning (on) — and compares the RETURNED candidates: how many, how
// many caches they cover, and how similar (Jaccard). Confirms the foreign-id
// leak drops to ~0 with grow on (the pool now covers the graph), and shows how
// much more cluster the feature recovers across the search boundary.
//
// Run inside the api container:
//   docker compose exec api node dist/tours/bench/discovery-compare.js
//
// Env: BENCH_OWNER_ID, BENCH_CENTER, BENCH_AREA_RADIUS_M, BENCH_SEED_SPACING_M,
//   BENCH_MAX_SEEDS, BENCH_RADIUS_M, BENCH_MAX_CACHES, BENCH_BUDGET_M, BENCH_TOPN.

import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { type Kysely } from "kysely";
import type { Database } from "@gctp/db";
import { Tours } from "@gctp/shared";
import { AppModule } from "../../app.module.js";
import { KYSELY } from "../../database/database.tokens.js";
import { jaccard, mean, num } from "./bench-metrics.js";
import { pickSeeds, resolveOwner } from "./corpus.js";

const log = new Logger("discovery-compare");

function foreignInSubgraphs(diag: Tours.ClusterDiagnostics): number {
  const pool = new Set(diag.cacheConnectivity.map((c) => c.cacheId));
  let f = 0;
  for (const comp of diag.components)
    for (const id of comp.cacheIds) if (!pool.has(id)) f += 1;
  return f;
}

/** Mean over `a` of its best Jaccard match in `b` (1 = every A cluster has an
 *  identical B twin). Empty `a` → 1 (nothing changed). */
function meanBestJaccard(a: number[][], b: number[][]): number {
  if (a.length === 0) return 1;
  const scores = a.map((ca) =>
    b.length === 0 ? 0 : Math.max(...b.map((cb) => jaccard(ca, cb))),
  );
  return mean(scores);
}

async function discover(
  planner: Tours.TourPlannerStrategy,
  ownerId: string,
  planInput: Tours.PlanInput,
  grow: boolean,
): Promise<Tours.DiscoverClustersResult> {
  if (grow) process.env.PLANNER_CLUSTER_GROW = "1";
  else delete process.env.PLANNER_CLUSTER_GROW;
  try {
    return await planner.discoverClusters(ownerId, planInput);
  } finally {
    delete process.env.PLANNER_CLUSTER_GROW;
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error"],
  });
  try {
    const db = app.get<Kysely<Database>>(KYSELY);
    const planner = app.get<Tours.TourPlannerStrategy>(Tours.TOUR_PLANNER);

    const ownerId = await resolveOwner(db);
    const spacing = num("BENCH_SEED_SPACING_M", 4000);
    const maxSeeds = Math.floor(num("BENCH_MAX_SEEDS", 30));
    const radiusM = Math.floor(num("BENCH_RADIUS_M", 5000));
    const maxCaches = Math.floor(num("BENCH_MAX_CACHES", 20));
    const budgetM = Math.floor(num("BENCH_BUDGET_M", 12000));
    const topN = Math.floor(num("BENCH_TOPN", 5));

    const seeds = await pickSeeds(db, ownerId, spacing, maxSeeds);
    log.log(`owner=${ownerId} seeds=${seeds.length}`);

    let seedsCompared = 0;
    let candCountA = 0;
    let candCountB = 0;
    let foreignA = 0;
    let foreignB = 0;
    let cacheCoverA = 0;
    let cacheCoverB = 0;
    const simScores: number[] = [];
    let seedsIdentical = 0;
    let seedsCandCountChanged = 0;

    for (const [lng, lat] of seeds) {
      try {
        const planInput = Tours.PlanInput.parse({
          center: [lng, lat],
          radiusM,
          maxCaches,
          distanceBudgetMeters: budgetM,
          hardFilters: {},
          softPreferences: {},
          topNClusters: topN,
        });
        const a = await discover(planner, ownerId, planInput, false);
        const b = await discover(planner, ownerId, planInput, true);
        seedsCompared += 1;

        const candA = a.candidates.map((c) => c.cacheIds);
        const candB = b.candidates.map((c) => c.cacheIds);
        candCountA += candA.length;
        candCountB += candB.length;
        foreignA += foreignInSubgraphs(a.diagnostics);
        foreignB += foreignInSubgraphs(b.diagnostics);
        cacheCoverA += candA.reduce((s, c) => s + c.length, 0);
        cacheCoverB += candB.reduce((s, c) => s + c.length, 0);

        const sim = meanBestJaccard(candA, candB);
        simScores.push(sim);
        if (candA.length !== candB.length) seedsCandCountChanged += 1;
        if (sim >= 0.999 && candA.length === candB.length) seedsIdentical += 1;
      } catch (e) {
        log.warn(`seed ${lng},${lat}: failed (${(e as Error).message})`);
      }
    }

    console.warn(
      "\n═══════════ boundary-spanning clusters — A/B impact ═══════════",
    );
    console.warn(
      `(A = current, B = boundary-spanning grow; ${seedsCompared} seeds)`,
    );
    console.warn(
      `foreign ids in subgraphs   : A ${foreignA}  →  B ${foreignB}`,
    );
    console.warn(
      `returned candidates (total): A ${candCountA}  →  B ${candCountB}`,
    );
    console.warn(
      `caches across candidates    : A ${cacheCoverA}  →  B ${cacheCoverB}`,
    );
    console.warn(
      `mean candidate similarity   : ${(mean(simScores) * 100).toFixed(1)}% (Jaccard A→B; 100% = unchanged)`,
    );
    console.warn(
      `seeds with identical results: ${seedsIdentical}/${seedsCompared}`,
    );
    console.warn(
      `seeds w/ changed candidate # : ${seedsCandCountChanged}/${seedsCompared}`,
    );
    console.warn(
      "(foreignB≈0 ⇒ leak closed; higher caches-covered ⇒ clusters recovered across the boundary)",
    );
  } finally {
    await app.close();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
