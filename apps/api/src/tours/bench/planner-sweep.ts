// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Planner quality lab: harvest MANY clusters across the whole DB (or a large
// circle) into a fixed corpus, then sweep planner settings over that corpus to
// compare tour quality and find the best configuration.
//
// Two stages, decoupled so settings are compared on identical clusters:
//   1. CORPUS  — discover clusters across the area, dedup overlapping ones,
//                cap, and (optionally) cache to a JSON file for re-runs.
//   2. SWEEP   — for every config in the matrix, plan every corpus cluster and
//                aggregate quality (realised retrace / distance / time / drops)
//                + speed (wall-clock). Prints a leaderboard.
//
// Headline quality metric is REALISED retrace — overlap of the ACTUAL OSRM
// polyline (cell re-entries), independent of the solver's straight-line proxy.
//
// Run inside the api container (correct DB/OSRM/Valkey env + compiled worker):
//   docker compose exec api node dist/tours/bench/planner-sweep.js
//
// Env knobs (all optional):
//   BENCH_OWNER_ID      owner uuid to plan for      (default: owner with most caches)
//   BENCH_CENTER        "lng,lat" centre of a large analysis circle (default: whole DB)
//   BENCH_AREA_RADIUS_M radius of that circle (m)                   (default 30000)
//   BENCH_SEED_SPACING_M grid spacing between discovery seeds (m)   (default 4000)
//   BENCH_MAX_SEEDS     cap on discovery seeds                      (default 30)
//   BENCH_TOPN          candidate clusters kept per seed            (default 2)
//   BENCH_MAX_CLUSTERS  cap on corpus size after dedup              (default 50)
//   BENCH_RADIUS_M      per-seed discovery radius (m)               (default 5000)
//   BENCH_MAX_CACHES    maxCaches per cluster                       (default 20)
//   BENCH_BUDGET_M      distanceBudgetMeters                        (default 12000)
//   BENCH_CORPUS_FILE   load corpus from / save corpus to this path (default: in-memory)
//   BENCH_CONFIGS       JSON file: [{ "label": "...", "env": { "PLANNER_*": "..." } }]
//                       (default: shortest + low-overlap at β 0.8/4/16/64)
//   BENCH_OUT           write full per-config-per-cluster JSON here (default: skip)

import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { sql, type Kysely } from "kysely";
import type { Database } from "@gctp/db";
import { Tours } from "@gctp/shared";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { AppModule } from "../../app.module.js";
import { KYSELY } from "../../database/database.tokens.js";
import {
  jaccard,
  mean,
  median,
  num,
  realisedRetraceMeters,
} from "./bench-metrics.js";

/** Measurement grid for realised retrace (independent of the solver's grid). */
const RETRACE_GRID_M = 25;

interface CorpusCluster {
  cacheIds: number[];
  size: number;
  center: [number, number];
}
interface Corpus {
  ownerId: string;
  clusters: CorpusCluster[];
}

interface BenchConfig {
  label: string;
  env: Record<string, string>;
}

const DEFAULT_CONFIGS: BenchConfig[] = [
  { label: "shortest", env: { PLANNER_LOOP_OBJECTIVE: "shortest" } },
  { label: "low β0.8", env: { PLANNER_LOOP_OBJECTIVE: "low-overlap", PLANNER_LOOP_ORDER_BETA: "0.8" } },
  { label: "low β4", env: { PLANNER_LOOP_OBJECTIVE: "low-overlap", PLANNER_LOOP_ORDER_BETA: "4" } },
  { label: "low β16", env: { PLANNER_LOOP_OBJECTIVE: "low-overlap", PLANNER_LOOP_ORDER_BETA: "16" } },
  { label: "low β64", env: { PLANNER_LOOP_OBJECTIVE: "low-overlap", PLANNER_LOOP_ORDER_BETA: "64" } },
];

const log = new Logger("planner-sweep");

async function resolveOwner(db: Kysely<Database>): Promise<string> {
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
 * Pick discovery seed centres: fetch the owner's cache locations in the area,
 * tile them on a grid of `spacing` m, and keep one representative cache per
 * tile. Guarantees seeds land where caches actually are.
 */
async function pickSeeds(
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
  const tile = new Map<string, [number, number]>(); // first cache per tile (sorted by id)
  for (const c of caches) {
    const mLng = c.lng * 111_320 * cosLat;
    const mLat = c.lat * 111_320;
    const key = `${Math.floor(mLng / spacing)}:${Math.floor(mLat / spacing)}`;
    if (!tile.has(key)) tile.set(key, [c.lng, c.lat]);
  }
  const seeds = [...tile.values()];
  if (seeds.length <= maxSeeds) return seeds;
  // Even sample across the tiles so coverage stays spread out.
  const step = seeds.length / maxSeeds;
  return Array.from({ length: maxSeeds }, (_, i) => seeds[Math.floor(i * step)]!);
}

async function buildCorpus(
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
        // Dedup: skip clusters that substantially overlap one already kept.
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

function loadConfigs(): BenchConfig[] {
  const file = process.env.BENCH_CONFIGS;
  if (!file) return DEFAULT_CONFIGS;
  return JSON.parse(readFileSync(file, "utf8")) as BenchConfig[];
}

function applyConfig(cfg: BenchConfig, allKeys: readonly string[]): void {
  for (const k of allKeys) {
    if (k in cfg.env) process.env[k] = cfg.env[k]!;
    else delete process.env[k];
  }
}

interface ConfigResult {
  label: string;
  nPlanned: number;
  retrace: number[];
  meters: number[];
  seconds: number[];
  dropped: number[];
  wallMs: number[];
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["warn", "error"],
  });
  try {
    const db = app.get<Kysely<Database>>(KYSELY);
    const planner = app.get<Tours.TourPlannerStrategy>(Tours.TOUR_PLANNER);
    const budgetM = Math.floor(num("BENCH_BUDGET_M", 12000));

    // ── Stage 1: corpus (load or build) ──────────────────────────────────
    const corpusFile = process.env.BENCH_CORPUS_FILE;
    let corpus: Corpus;
    if (corpusFile && existsSync(corpusFile)) {
      corpus = JSON.parse(readFileSync(corpusFile, "utf8")) as Corpus;
      log.log(`loaded corpus: ${corpus.clusters.length} clusters from ${corpusFile}`);
    } else {
      const ownerId = await resolveOwner(db);
      corpus = await buildCorpus(db, planner, ownerId);
      if (corpusFile) {
        writeFileSync(corpusFile, JSON.stringify(corpus, null, 2));
        log.log(`saved corpus to ${corpusFile}`);
      }
    }
    if (corpus.clusters.length === 0) {
      console.warn("Empty corpus — nothing to sweep.");
      return;
    }

    // ── Stage 2: sweep configs over the fixed corpus ─────────────────────
    const configs = loadConfigs();
    const allKeys = [...new Set(configs.flatMap((c) => Object.keys(c.env)))];
    const out: Record<string, unknown>[] = [];
    const results: ConfigResult[] = [];

    for (const cfg of configs) {
      applyConfig(cfg, allKeys);
      const r: ConfigResult = {
        label: cfg.label,
        nPlanned: 0,
        retrace: [],
        meters: [],
        seconds: [],
        dropped: [],
        wallMs: [],
      };
      for (const cluster of corpus.clusters) {
        try {
          const loopInput = Tours.PlanLoopInput.parse({
            cacheIds: cluster.cacheIds,
            distanceBudgetMeters: budgetM,
            // loopObjective omitted on purpose — the config's env drives it.
          });
          const t0 = performance.now();
          const res = await planner.planLoop(corpus.ownerId, loopInput);
          const wallMs = performance.now() - t0;
          const retraceM = realisedRetraceMeters(res.polyline, RETRACE_GRID_M);
          r.nPlanned += 1;
          r.retrace.push(retraceM);
          r.meters.push(res.totals.meters);
          r.seconds.push(res.totals.seconds);
          r.dropped.push(res.droppedCacheIds.length);
          r.wallMs.push(wallMs);
          out.push({
            config: cfg.label,
            clusterSize: cluster.size,
            retraceM,
            meters: res.totals.meters,
            seconds: res.totals.seconds,
            dropped: res.droppedCacheIds.length,
            wallMs,
          });
        } catch (e) {
          log.warn(`${cfg.label}: plan failed on a cluster (${(e as Error).message})`);
        }
      }
      results.push(r);
      log.log(
        `${cfg.label}: planned ${r.nPlanned} — mean retrace ${mean(r.retrace).toFixed(0)}m`,
      );
    }

    leaderboard(results);
    if (process.env.BENCH_OUT) {
      writeFileSync(process.env.BENCH_OUT, JSON.stringify(out, null, 2));
      log.log(`wrote ${out.length} rows to ${process.env.BENCH_OUT}`);
    }
  } finally {
    await app.close();
  }
}

function leaderboard(results: ConfigResult[]): void {
  const baseline = results.find((r) => r.label === "shortest");
  const baseRetrace = baseline ? mean(baseline.retrace) : 0;
  const ranked = [...results].sort((a, b) => mean(a.retrace) - mean(b.retrace));

  const pad = (s: string, w: number): string => s.padEnd(w);
  const padL = (s: string, w: number): string => s.padStart(w);
  console.warn("\n══════════════════ planner sweep leaderboard ══════════════════");
  console.warn(
    `${pad("config", 12)} ${padL("n", 4)} ${padL("retrace", 9)} ${padL("med", 7)} ${padL("vs base", 9)} ${padL("dist", 8)} ${padL("time", 7)} ${padL("drop", 5)} ${padL("wall", 7)}`,
  );
  console.warn("─".repeat(74));
  for (const r of ranked) {
    const mr = mean(r.retrace);
    const vsBase =
      baseRetrace > 0 && r.label !== "shortest"
        ? `${(((mr - baseRetrace) / baseRetrace) * 100).toFixed(1)}%`
        : "—";
    console.warn(
      `${pad(r.label, 12)} ${padL(String(r.nPlanned), 4)} ${padL(`${mr.toFixed(0)}m`, 9)} ${padL(`${median(r.retrace).toFixed(0)}m`, 7)} ${padL(vsBase, 9)} ${padL(`${(mean(r.meters) / 1000).toFixed(1)}km`, 8)} ${padL(`${(mean(r.seconds) / 60).toFixed(0)}min`, 7)} ${padL(mean(r.dropped).toFixed(1), 5)} ${padL(`${mean(r.wallMs).toFixed(0)}ms`, 7)}`,
    );
  }
  console.warn("(lower retrace = better; vs base = mean realised retrace vs the shortest config)");
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
