// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// ComputePool (ADR-0014): a piscina worker-thread pool for the planner's
// CPU-heavy pure computations (TSP solve + cluster-discovery pipeline). Keeps
// the API event loop free so one user's heavy plan can't block everyone else —
// the prerequisite for multi-user. Only serializable pure functions cross the
// boundary; all I/O (OSRM, Postgres) stays on the main thread.

import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { availableParallelism } from "node:os";
import { Piscina } from "piscina";
import type { Tours, Tsp } from "@gctp/shared";
import type { PreparedContext } from "../strategies/greedy/clustering/context.js";
import type { PlannerResult, PlannerTask } from "./planner.worker.js";

/** DI token so the planner can depend on the abstraction, not the class. */
export const COMPUTE_POOL = Symbol.for("@gctp/api/tours/COMPUTE_POOL");

export interface ComputePool {
  solveTwoOpt(
    distances: Tsp.DistanceMatrix,
    startIndex: number,
    options?: Tsp.SolveTwoOptOptions,
  ): Promise<Tsp.TwoOptResult>;
  computeClusters(
    ctx: PreparedContext,
    strategyName: Tours.ClusteringStrategyName,
    preferredLanduseKinds: readonly string[],
  ): Promise<Tours.DiscoverClustersResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** `PLANNER_WORKER_THREADS` (clamped 1..16); default leaves a core for the
 *  event loop + OSRM and caps small (the host is 4C/8T and OSRM uses ~4). */
function readThreadCount(): number {
  const raw = Number(process.env.PLANNER_WORKER_THREADS);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(16, Math.floor(raw));
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

/** `PLANNER_WORKER_TIMEOUT_MS` (default 30s) — aborts a task that blows the
 *  budget so a pathological input can't tie up a worker forever. */
function readTimeoutMs(): number {
  const raw = Number(process.env.PLANNER_WORKER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
}

@Injectable()
export class PiscinaComputePool implements ComputePool, OnModuleDestroy {
  private readonly logger = new Logger(PiscinaComputePool.name);
  private readonly pool: Piscina;
  private readonly timeoutMs = readTimeoutMs();

  constructor() {
    const maxThreads = readThreadCount();
    this.pool = new Piscina({
      filename: new URL("./planner.worker.js", import.meta.url).href,
      maxThreads,
      minThreads: 1, // keep one warm so the first request isn't cold
    });
    this.logger.log(
      `ComputePool ready: ${maxThreads} worker thread(s), task timeout ${this.timeoutMs}ms`,
    );
  }

  private run<T extends PlannerResult>(task: PlannerTask): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    return this.pool
      .run(task, { signal: ac.signal })
      .finally(() => clearTimeout(timer)) as Promise<T>;
  }

  solveTwoOpt(
    distances: Tsp.DistanceMatrix,
    startIndex: number,
    options?: Tsp.SolveTwoOptOptions,
  ): Promise<Tsp.TwoOptResult> {
    return this.run<Tsp.TwoOptResult>({
      kind: "tsp",
      distances,
      startIndex,
      options,
    });
  }

  computeClusters(
    ctx: PreparedContext,
    strategyName: Tours.ClusteringStrategyName,
    preferredLanduseKinds: readonly string[],
  ): Promise<Tours.DiscoverClustersResult> {
    // Drop the request-scoped projection before crossing the worker boundary:
    // its methods aren't structure-cloneable (DataCloneError). The worker
    // rebuilds it from `ctx.input.center`. See planner.worker.ts ClusterTask.
    const { projection: _projection, ...serializableCtx } = ctx;
    return this.run<Tours.DiscoverClustersResult>({
      kind: "cluster",
      ctx: serializableCtx,
      strategyName,
      preferredLanduseKinds: [...preferredLanduseKinds],
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log("Draining ComputePool…");
    await this.pool.destroy();
  }
}
