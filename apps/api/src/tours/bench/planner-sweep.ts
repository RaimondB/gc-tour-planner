// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Planner quality lab: harvest MANY clusters across the whole DB (or a large
// circle) into a fixed corpus, then sweep planner settings over that corpus to
// compare tour quality and find the best configuration.
//
// Two stages, decoupled so settings are compared on identical clusters:
//   1. CORPUS  — discover clusters across the area, dedup, cap, optionally cache
//                to a JSON file for re-runs.
//   2. SWEEP   — for every config in the matrix, plan every corpus cluster and
//                aggregate quality (realised retrace / distance / time / drops)
//                + speed (wall-clock). Prints a leaderboard.
//
// Headline quality metric is REALISED retrace — overlap of the ACTUAL OSRM
// polyline (cell re-entries). Each config is a set of PLANNER_* env overrides
// applied (per planLoop call) before planning, so any per-plan knob is sweepable
// (loop-picker alpha, marginal/fringe trim, …).
//
// Run inside the api container (correct DB/OSRM/Valkey env + compiled worker):
//   docker compose exec api node dist/tours/bench/planner-sweep.js
//
// Env knobs — corpus: BENCH_OWNER_ID, BENCH_CENTER ("lng,lat"),
//   BENCH_AREA_RADIUS_M (30000), BENCH_SEED_SPACING_M (4000), BENCH_MAX_SEEDS
//   (30), BENCH_TOPN (2), BENCH_MAX_CLUSTERS (50), BENCH_RADIUS_M (5000),
//   BENCH_MAX_CACHES (20), BENCH_BUDGET_M (12000), BENCH_CORPUS_FILE (cache path).
// Env knobs — sweep: BENCH_CONFIGS (JSON: [{ "label", "env": {…} }]; default
//   sweeps the loop-picker PLANNER_LOOP_ALPHA), BENCH_OUT (per-row JSON path).

import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Kysely } from "kysely";
import type { Database } from "@gctp/db";
import { Tours } from "@gctp/shared";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { AppModule } from "../../app.module.js";
import { KYSELY } from "../../database/database.tokens.js";
import { mean, median, num, realisedRetraceMeters } from "./bench-metrics.js";
import { buildCorpus, resolveOwner, type Corpus } from "./corpus.js";

/** Measurement grid for realised retrace (independent of any solver grid). */
const RETRACE_GRID_M = 25;

interface BenchConfig {
  label: string;
  env: Record<string, string>;
}

/** Default sweep: the post-order loop-picker overlap weight (PLANNER_LOOP_ALPHA),
 *  a real anti-retrace knob on main. Override with BENCH_CONFIGS. */
const DEFAULT_CONFIGS: BenchConfig[] = [
  { label: "alpha0", env: { PLANNER_LOOP_ALPHA: "0" } },
  { label: "alpha1", env: { PLANNER_LOOP_ALPHA: "1" } },
  { label: "alpha2", env: { PLANNER_LOOP_ALPHA: "2" } },
];

const log = new Logger("planner-sweep");

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
      log.log(
        `loaded corpus: ${corpus.clusters.length} clusters from ${corpusFile}`,
      );
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
          log.warn(
            `${cfg.label}: plan failed on a cluster (${(e as Error).message})`,
          );
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
  const baseline = results[0];
  const baseRetrace = baseline ? mean(baseline.retrace) : 0;
  const ranked = [...results].sort((a, b) => mean(a.retrace) - mean(b.retrace));

  const pad = (s: string, w: number): string => s.padEnd(w);
  const padL = (s: string, w: number): string => s.padStart(w);
  console.warn(
    "\n══════════════════ planner sweep leaderboard ══════════════════",
  );
  console.warn(
    `${pad("config", 12)} ${padL("n", 4)} ${padL("retrace", 9)} ${padL("med", 7)} ${padL("vs base", 9)} ${padL("dist", 8)} ${padL("time", 7)} ${padL("drop", 5)} ${padL("wall", 7)}`,
  );
  console.warn("─".repeat(74));
  for (const r of ranked) {
    const mr = mean(r.retrace);
    const vsBase =
      baseRetrace > 0 && r.label !== baseline?.label
        ? `${(((mr - baseRetrace) / baseRetrace) * 100).toFixed(1)}%`
        : "—";
    console.warn(
      `${pad(r.label, 12)} ${padL(String(r.nPlanned), 4)} ${padL(`${mr.toFixed(0)}m`, 9)} ${padL(`${median(r.retrace).toFixed(0)}m`, 7)} ${padL(vsBase, 9)} ${padL(`${(mean(r.meters) / 1000).toFixed(1)}km`, 8)} ${padL(`${(mean(r.seconds) / 60).toFixed(0)}min`, 7)} ${padL(mean(r.dropped).toFixed(1), 5)} ${padL(`${mean(r.wallMs).toFixed(0)}ms`, 7)}`,
    );
  }
  console.warn(
    "(lower retrace = better; vs base = mean realised retrace vs the first config)",
  );
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
