// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared corpus building for the planner bench tools: resolve the owner to plan
// for, pick discovery seed centres across the area, and harvest a deduped set
// of real clusters. No HTTP/auth — runs inside a headless app context.

import { Logger } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import type { Database } from "@gctp/db";
import { Tours } from "@gctp/shared";
import { jaccard, num } from "./bench-metrics.js";

export interface CorpusCluster {
  cacheIds: number[];
  size: number;
  center: [number, number];
}
export interface Corpus {
  ownerId: string;
  clusters: CorpusCluster[];
}

const log = new Logger("bench-corpus");

/** Owner to plan for: `BENCH_OWNER_ID`, else the user with the most caches. */
export async function resolveOwner(db: Kysely<Database>): Promise<string> {
  if (process.env.BENCH_OWNER_ID) return process.env.BENCH_OWNER_ID;
  const top = await db
    .selectFrom("caches")
    .select(["owner_id"])
    .where("owner_id", "is not", null)
    .groupBy("owner_id")
    .orderBy(sql`count(*)`, "desc")
    .limit(1)
    .executeTakeFirst();
  if (!top?.owner_id) throw new Error("no owned caches found in this database");
  return top.owner_id;
}

/**
 * Pick discovery seed centres: fetch the owner's cache locations in the area
 * (whole DB, or the `BENCH_CENTER` + `BENCH_AREA_RADIUS_M` circle), tile them on
 * a grid of `spacing` m, and keep one representative cache per tile. Guarantees
 * seeds land where caches actually are; evenly samples down to `maxSeeds`.
 */
export async function pickSeeds(
  db: Kysely<Database>,
  ownerId: string,
  spacing: number,
  maxSeeds: number,
): Promise<[number, number][]> {
  let q = db
    .selectFrom("caches")
    .select([
      "id",
      sql<number>`ST_X(location::geometry)`.as("lng"),
      sql<number>`ST_Y(location::geometry)`.as("lat"),
    ])
    .where("owner_id", "=", ownerId);
  const center = process.env.BENCH_CENTER?.split(",").map(Number);
  if (center && center.length === 2 && center.every(Number.isFinite)) {
    const r = num("BENCH_AREA_RADIUS_M", 30_000);
    q = q.where(
      sql<boolean>`ST_DWithin(location, ST_SetSRID(ST_MakePoint(${center[0]}, ${center[1]}), 4326)::geography, ${r})`,
    );
  }
  const caches = await q.orderBy("id").execute();
  if (caches.length === 0) return [];

  const originLat = caches[0]!.lat;
  const cosLat = Math.cos((originLat * Math.PI) / 180);
  const tile = new Map<string, [number, number]>(); // first cache per tile (id-sorted)
  for (const c of caches) {
    const mLng = c.lng * 111_320 * cosLat;
    const mLat = c.lat * 111_320;
    const key = `${Math.floor(mLng / spacing)}:${Math.floor(mLat / spacing)}`;
    if (!tile.has(key)) tile.set(key, [c.lng, c.lat]);
  }
  const seeds = [...tile.values()];
  if (seeds.length <= maxSeeds) return seeds;
  const step = seeds.length / maxSeeds;
  return Array.from({ length: maxSeeds }, (_, i) => seeds[Math.floor(i * step)]!);
}

/**
 * Harvest a deduped corpus of clusters across the area: discover per seed,
 * keep distinct candidates (Jaccard ≤ 0.5 with anything already kept), cap.
 */
export async function buildCorpus(
  db: Kysely<Database>,
  planner: Tours.TourPlannerStrategy,
  ownerId: string,
): Promise<Corpus> {
  const spacing = num("BENCH_SEED_SPACING_M", 4000);
  const maxSeeds = Math.floor(num("BENCH_MAX_SEEDS", 30));
  const topN = Math.floor(num("BENCH_TOPN", 2));
  const maxClusters = Math.floor(num("BENCH_MAX_CLUSTERS", 50));
  const radiusM = Math.floor(num("BENCH_RADIUS_M", 5000));
  const maxCaches = Math.floor(num("BENCH_MAX_CACHES", 20));
  const budgetM = Math.floor(num("BENCH_BUDGET_M", 12000));

  const seeds = await pickSeeds(db, ownerId, spacing, maxSeeds);
  log.log(`discovering across ${seeds.length} seed(s)…`);

  const clusters: CorpusCluster[] = [];
  for (const [lng, lat] of seeds) {
    if (clusters.length >= maxClusters) break;
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
      const discovered = await planner.discoverClusters(ownerId, planInput);
      for (const cand of discovered.candidates) {
        if (cand.cacheIds.length < 2) continue;
        if (clusters.some((c) => jaccard(c.cacheIds, cand.cacheIds) > 0.5)) continue;
        clusters.push({ cacheIds: cand.cacheIds, size: cand.cacheIds.length, center: [lng, lat] });
        if (clusters.length >= maxClusters) break;
      }
    } catch (e) {
      log.warn(`seed ${lng},${lat}: discovery failed (${(e as Error).message})`);
    }
  }
  log.log(`corpus: ${clusters.length} distinct clusters`);
  return { ownerId, clusters };
}
