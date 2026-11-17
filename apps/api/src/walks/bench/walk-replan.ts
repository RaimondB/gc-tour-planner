// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ad-hoc walk replan bench (ADR-0040): end-to-end latency of
// WalksService.replan on real data, and how stable the route stays when the
// walker's GPS fix jitters by a few metres between replans.
//
// Run inside the api container (real DB / OSRM / worker pool):
//   docker compose exec api node dist/walks/bench/walk-replan.js
//
// Env: BENCH_OWNER_ID, BENCH_SEED_SPACING_M (3000), BENCH_MAX_SEEDS (12),
//   BENCH_DURATIONS ("60,120,180" minutes), BENCH_JITTER_M (25),
//   BENCH_JITTER_STEPS (5).

import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Kysely } from "kysely";
import type { Database } from "@gctp/db";
import { RouteProfiles, Walks } from "@gctp/shared";
import { AppModule } from "../../app.module.js";
import { KYSELY } from "../../database/database.tokens.js";
import { num } from "../../tours/bench/bench-metrics.js";
import { pickSeeds, resolveOwner } from "../../tours/bench/corpus.js";
import { WalksService } from "../walks.service.js";

const log = new Logger("walk-replan-bench");

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

/** Move a point ~`meters` in a deterministic direction (step k). */
function jitter(
  p: [number, number],
  meters: number,
  k: number,
): [number, number] {
  const angle = (k * 137.5 * Math.PI) / 180;
  const dLat = (meters * Math.cos(angle)) / 111_320;
  const dLng =
    (meters * Math.sin(angle)) / (111_320 * Math.cos((p[1] * Math.PI) / 180));
  return [p[0] + dLng, p[1] + dLat];
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["warn", "error"],
  });
  try {
    const db = app.get<Kysely<Database>>(KYSELY);
    const walks = app.get(WalksService);
    const ownerId = await resolveOwner(db);
    const seeds = await pickSeeds(
      db,
      ownerId,
      num("BENCH_SEED_SPACING_M", 3000),
      num("BENCH_MAX_SEEDS", 12),
    );
    const durations = (process.env.BENCH_DURATIONS ?? "60,120,180")
      .split(",")
      .map(Number);
    const jitterM = num("BENCH_JITTER_M", 25);
    const steps = num("BENCH_JITTER_STEPS", 5);
    const profile = RouteProfiles.RouteProfileSettings.parse({});
    const now = new Date().toISOString();

    for (const minutes of durations) {
      const wall: number[] = [];
      const stops: number[] = [];
      let feasible = 0;
      let keptPrev = 0;
      let changedNext = 0;
      let replans = 0;
      for (const seed of seeds) {
        const deadline = new Date(Date.now() + minutes * 60_000).toISOString();
        const base = { returnPoint: seed, deadline, now, profile };
        const t0 = performance.now();
        const first = await walks.replan(
          ownerId,
          Walks.WalkReplanInput.parse({ ...base, position: seed }),
        );
        wall.push(performance.now() - t0);
        stops.push(first.order.length);
        if (first.feasible) feasible += 1;
        // Stability: replan from jittered fixes with the current route.
        let previous = first.order.map((s) => s.cacheId);
        for (let k = 1; k <= steps; k += 1) {
          const t1 = performance.now();
          const res = await walks.replan(
            ownerId,
            Walks.WalkReplanInput.parse({
              ...base,
              position: jitter(seed, jitterM, k),
              previousOrder: previous,
            }),
          );
          wall.push(performance.now() - t1);
          replans += 1;
          if (res.kept === "previous") keptPrev += 1;
          if (res.order[0]?.cacheId !== previous[0]) changedNext += 1;
          previous = res.order.map((s) => s.cacheId);
        }
      }
      log.warn(
        `${minutes} min · ${seeds.length} starts: latency p50 ${percentile(wall, 50).toFixed(0)} ms, ` +
          `p95 ${percentile(wall, 95).toFixed(0)} ms · stops avg ${(stops.reduce((a, b) => a + b, 0) / Math.max(1, stops.length)).toFixed(1)} · ` +
          `feasible ${feasible}/${seeds.length} · jittered replans: kept ${keptPrev}/${replans}, next stop changed ${changedNext}/${replans}`,
      );
    }
  } finally {
    await app.close();
  }
}

void main();
