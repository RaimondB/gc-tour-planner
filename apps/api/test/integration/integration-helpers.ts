// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared wiring for the integration specs. Services have grown constructor
// dependencies over time (raw-GPX storage, the walking-precompute queue, the
// piscina compute pool, OSRM extract versioning); these helpers build the
// real collaborators against the Testcontainer DB and supply lightweight,
// faithful fakes for the out-of-process bits (queue, worker pool) so the
// specs exercise the real SQL + planner logic without a Valkey or worker
// thread. No DB mocks — per CLAUDE.md.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import type { Queue } from "bullmq";
import type { Database } from "@gctp/db";
import { Tsp } from "@gctp/shared";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import { CachesService } from "../../src/caches/caches.service.js";
import { GpxRepository } from "../../src/gpx/gpx.repository.js";
import { GpxService } from "../../src/gpx/gpx.service.js";
import { GpxStorageService } from "../../src/gpx/gpx-storage.service.js";
import type { WalkingPrecomputeJobData } from "../../src/jobs/walking-precompute/walking-precompute.types.js";
import { OsrmVersionService } from "../../src/routing/osrm-version.service.js";
import type { ComputePool } from "../../src/tours/compute/compute-pool.service.js";
import { computeClusters } from "../../src/tours/strategies/greedy/discover-compute.js";

/**
 * A no-op stand-in for the BullMQ walking-precompute queue. The ingest path
 * enqueues a precompute job; integration tests assert the DB upsert result,
 * not the async job, so we just swallow the enqueue (no Valkey needed).
 */
export function fakeWalkingQueue(): Queue<WalkingPrecomputeJobData> {
  return {
    add: async () => ({}) as never,
  } as unknown as Queue<WalkingPrecomputeJobData>;
}

/**
 * Build a real GpxService against the Testcontainer DB. Raw uploads are
 * written to a throwaway temp dir; the precompute queue is faked.
 */
export function makeGpxService(db: Kysely<Database>): GpxService {
  const storage = new GpxStorageService(
    mkdtempSync(join(tmpdir(), "gctp-it-")),
  );
  return new GpxService(new GpxRepository(db), storage, fakeWalkingQueue());
}

/**
 * Build a real CachesService against the Testcontainer DB with a faked
 * walking-precompute queue (used by the remove-solved re-warm path).
 */
export function makeCachesService(db: Kysely<Database>): CachesService {
  return new CachesService(new CachesRepository(db), fakeWalkingQueue());
}

/** `new OsrmVersionService()` re-reads its file each `getVersion()` call and
 *  returns "unknown" when absent — fine and deterministic for tests. */
export function makeOsrmVersion(): OsrmVersionService {
  return new OsrmVersionService();
}

/**
 * An inline ComputePool that runs the planner's pure computations on the main
 * thread instead of a piscina worker. Mirrors `planner.worker.ts` exactly
 * (Tsp.solveTwoOpt / computeClusters), so the tested logic is identical — only
 * the thread boundary is removed.
 */
export function fakeComputePool(): ComputePool {
  return {
    async solveTwoOpt(distances, startIndex, options) {
      return Tsp.solveTwoOpt(distances, startIndex, options);
    },
    async solveLowOverlapLoop(distances, startIndex, coords, options) {
      return Tsp.solveLowOverlapLoop(distances, startIndex, coords, options);
    },
    async computeClusters(ctx, strategyName, preferredLanduseKinds) {
      return computeClusters(ctx, strategyName, [...preferredLanduseKinds]);
    },
  };
}
