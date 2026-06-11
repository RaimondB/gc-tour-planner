// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Discovery diagnostics: quantify the "[discover-compute] … refine→pool
// invariant broken" warning by running Pass-1 discovery across many seeds and
// inspecting the returned diagnostics.
//
// The warning fires when a cluster contains cache ids NOT in the candidate pool,
// so the cluster hydrates to (near-)empty and is silently dropped — i.e. real
// clusters may be lost. We detect it WITHOUT touching the planner: the result's
// `diagnostics.components[].cacheIds` are the clusters and
// `diagnostics.cacheConnectivity[].cacheId` is the pool, so any component id not
// in the pool is a "foreign" id. We also intercept the worker's own warning
// lines (forwarded to stderr) as a cross-check, and query the DB to classify the
// foreign ids: do they exist as caches at all, and are they owned by this user?
//
// Run inside the api container:
//   docker compose exec api node dist/tours/bench/discovery-diag.js
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
import { num } from "./bench-metrics.js";
import { pickSeeds, resolveOwner } from "./corpus.js";

const log = new Logger("discovery-diag");

interface StrategyStat {
  discoveries: number;
  components: number;
  componentsWithForeign: number;
  foreignIdTotal: number;
  candidates: number;
  candidatesWithForeign: number;
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["warn", "error"],
  });

  // Cross-check: tally the worker's own warnings (piscina forwards them here).
  let invariantBrokenLines = 0;
  let droppedSubMinLines = 0;
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (s.includes("invariant broken")) invariantBrokenLines += 1;
    if (s.includes("sub-minimum")) droppedSubMinLines += 1;
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;

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

    const byStrategy = new Map<string, StrategyStat>();
    const stat = (k: string): StrategyStat => {
      let s = byStrategy.get(k);
      if (!s) {
        s = { discoveries: 0, components: 0, componentsWithForeign: 0, foreignIdTotal: 0, candidates: 0, candidatesWithForeign: 0 };
        byStrategy.set(k, s);
      }
      return s;
    };
    const foreignSample = new Set<number>();

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
        const { candidates, diagnostics } = await planner.discoverClusters(ownerId, planInput);
        const s = stat(diagnostics.strategyUsed);
        s.discoveries += 1;
        const poolIds = new Set(diagnostics.cacheConnectivity.map((c) => c.cacheId));
        for (const comp of diagnostics.components) {
          s.components += 1;
          const foreign = comp.cacheIds.filter((id) => !poolIds.has(id));
          if (foreign.length > 0) {
            s.componentsWithForeign += 1;
            s.foreignIdTotal += foreign.length;
            for (const id of foreign) if (foreignSample.size < 500) foreignSample.add(id);
          }
        }
        for (const cand of candidates) {
          s.candidates += 1;
          if (cand.cacheIds.some((id) => !poolIds.has(id))) s.candidatesWithForeign += 1;
        }
      } catch (e) {
        log.warn(`seed ${lng},${lat}: discovery failed (${(e as Error).message})`);
      }
    }

    // Classify the foreign ids against the DB.
    let existInDb = 0;
    let ownedBySameOwner = 0;
    if (foreignSample.size > 0) {
      const rows = await db
        .selectFrom("caches")
        .select(["id", "owner_id"])
        .where("id", "in", [...foreignSample])
        .execute();
      existInDb = rows.length;
      ownedBySameOwner = rows.filter((r) => r.owner_id === ownerId).length;
    }

    process.stderr.write = origWrite as typeof process.stderr.write;
    report(byStrategy, foreignSample.size, existInDb, ownedBySameOwner, invariantBrokenLines, droppedSubMinLines);
  } finally {
    process.stderr.write = origWrite as typeof process.stderr.write;
    await app.close();
  }
}

function report(
  byStrategy: Map<string, StrategyStat>,
  sampledForeign: number,
  existInDb: number,
  ownedBySameOwner: number,
  invariantBrokenLines: number,
  droppedSubMinLines: number,
): void {
  console.warn("\n════════════════ discovery invariant diagnostics ════════════════");
  for (const [strategy, s] of byStrategy) {
    console.warn(`strategy: ${strategy}`);
    console.warn(`  discoveries                 : ${s.discoveries}`);
    console.warn(`  components (clusters)        : ${s.components}`);
    console.warn(`  components with foreign ids  : ${s.componentsWithForeign} (${pct(s.componentsWithForeign, s.components)})`);
    console.warn(`  foreign ids total            : ${s.foreignIdTotal}`);
    console.warn(`  returned candidates          : ${s.candidates}`);
    console.warn(`  candidates with foreign ids  : ${s.candidatesWithForeign}`);
  }
  console.warn("\nForeign-id classification (sampled):");
  console.warn(`  sampled foreign ids          : ${sampledForeign}`);
  console.warn(`  exist as caches in DB        : ${existInDb} (${pct(existInDb, sampledForeign)})`);
  console.warn(`  …owned by the SAME owner     : ${ownedBySameOwner}`);
  console.warn(`  …NOT in DB (phantom/index?)  : ${sampledForeign - existInDb}`);
  console.warn("\nWorker warning lines seen (cross-check):");
  console.warn(`  'invariant broken'           : ${invariantBrokenLines}`);
  console.warn(`  'sub-minimum dropped'        : ${droppedSubMinLines}`);
}

function pct(v: number, base: number): string {
  return base > 0 ? `${((v / base) * 100).toFixed(1)}%` : "n/a";
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
