// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { Caches, Tours } from "@gctp/shared";
import type { ConfigService } from "@nestjs/config";
import type { CachesRepository } from "../caches/caches.repository.js";
import { ToursService } from "./tours.service.js";

/** Minimal CacheDTO-ish stub — only the fields planLoop selection reads. */
function cache(
  id: number,
  type: string,
  adventureId: string | null = null,
): Caches.CacheDTO {
  return { id, type, adventureId } as unknown as Caches.CacheDTO;
}

const ownerId = "o1";
const PLAN: Tours.PlanResult = {
  orderedCacheIds: [],
} as unknown as Tours.PlanResult;

/**
 * Per-request planner selection (FR-I16): the solver routes only when the
 * candidate set contains an Adventure Lab; a solver outage falls back to greedy
 * so an AL plan still returns. `TOUR_PLANNER` (auto|greedy|solver) overrides.
 */
function makeService(opts: {
  mode?: string;
  rows: Caches.CacheDTO[];
  stages?: Caches.CacheDTO[];
  solverThrows?: unknown;
}) {
  const greedy = {
    planLoop: vi.fn().mockResolvedValue(PLAN),
  } as unknown as Tours.TourPlannerStrategy;
  const solver = {
    planLoop: opts.solverThrows
      ? vi.fn().mockRejectedValue(opts.solverThrows)
      : vi.fn().mockResolvedValue(PLAN),
  } as unknown as Tours.TourPlannerStrategy;
  const config = {
    get: vi.fn().mockReturnValue(opts.mode),
  } as unknown as ConfigService;
  const cachesRepo = {
    findByIds: vi.fn().mockResolvedValue(opts.rows),
    findAdventureStages: vi.fn().mockResolvedValue(opts.stages ?? []),
  } as unknown as CachesRepository;

  const svc = new ToursService(
    null as never, // planner (legacy single binding, unused by planLoop)
    greedy,
    solver,
    config,
    null as never, // caches (CachesService)
    cachesRepo,
    null as never, // cacheLanduse
    null as never, // routing
    null as never, // routingRepo
    null as never, // osrm
    null as never, // osrmVersion
    null as never, // adventureLab
  );
  return { svc, greedy, solver };
}

const input: Tours.PlanLoopInput = {
  cacheIds: [1, 2],
} as unknown as Tours.PlanLoopInput;

describe("ToursService.planLoop — strategy selection", () => {
  it("auto: cache-only cluster uses the greedy planner", async () => {
    const { svc, greedy, solver } = makeService({
      mode: "auto",
      rows: [cache(1, "traditional"), cache(2, "traditional")],
    });
    await svc.planLoop(ownerId, input);
    expect(greedy.planLoop).toHaveBeenCalledOnce();
    expect(solver.planLoop).not.toHaveBeenCalled();
  });

  it("auto: an Adventure Lab in the cluster routes to the solver", async () => {
    const { svc, greedy, solver } = makeService({
      mode: "auto",
      rows: [cache(1, "Adventure Lab", "A1"), cache(2, "traditional")],
      stages: [
        cache(1, "Adventure Lab", "A1"),
        cache(3, "Adventure Lab", "A1"),
      ],
    });
    await svc.planLoop(ownerId, input);
    expect(solver.planLoop).toHaveBeenCalledOnce();
    expect(greedy.planLoop).not.toHaveBeenCalled();
  });

  it("greedy override: never calls the solver, even with an Adventure Lab", async () => {
    const { svc, greedy, solver } = makeService({
      mode: "greedy",
      rows: [cache(1, "Adventure Lab", "A1")],
    });
    await svc.planLoop(ownerId, input);
    expect(greedy.planLoop).toHaveBeenCalledOnce();
    expect(solver.planLoop).not.toHaveBeenCalled();
  });

  it("falls back to greedy when the solver is unavailable", async () => {
    const { svc, greedy, solver } = makeService({
      mode: "solver",
      rows: [cache(1, "Adventure Lab", "A1")],
      stages: [cache(1, "Adventure Lab", "A1")],
      solverThrows: new ServiceUnavailableException("solver down"),
    });
    const res = await svc.planLoop(ownerId, input);
    expect(solver.planLoop).toHaveBeenCalledOnce();
    expect(greedy.planLoop).toHaveBeenCalledOnce();
    expect(res).toBe(PLAN);
  });
});
