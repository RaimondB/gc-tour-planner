// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { Caches, Routing, Tours } from "@gctp/shared";
import type { ConfigService } from "@nestjs/config";
import type { CachesRepository } from "../caches/caches.repository.js";
import type { RoutingService } from "../routing/routing.service.js";
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
 * Fully-connected (or custom) walking matrix over the requested ids. Default
 * 100 m everywhere → every adventure passes the cohesion gate, so the existing
 * strategy-selection assertions are unaffected. A test can pass `unreachableIds`
 * to strand specific stages (no edge to anything).
 */
function makeMatrix(
  ids: readonly number[],
  unreachable: ReadonlySet<number>,
): Routing.Matrix {
  const list = [...ids];
  return {
    profile: "foot",
    cacheIds: list,
    legs: list.map((a) =>
      list.map((b) =>
        a === b
          ? { meters: 0, seconds: 0 }
          : unreachable.has(a) || unreachable.has(b)
            ? null
            : { meters: 100, seconds: 100 },
      ),
    ),
  };
}

function makeService(opts: {
  mode?: string;
  rows: Caches.CacheDTO[];
  stages?: Caches.CacheDTO[];
  solverThrows?: unknown;
  unreachableIds?: number[];
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
  const unreachable = new Set(opts.unreachableIds ?? []);
  const routing = {
    getMatrix: vi
      .fn()
      .mockImplementation(async (_ownerId: string, ids: number[]) =>
        makeMatrix(ids, unreachable),
      ),
  } as unknown as RoutingService;

  const svc = new ToursService(
    null as never, // planner (legacy single binding, unused by planLoop)
    greedy,
    solver,
    config,
    null as never, // caches (CachesService)
    cachesRepo,
    null as never, // cacheLanduse
    routing,
    null as never, // routingRepo
    null as never, // osrm
    null as never, // osrmVersion
    null as never, // adventureLab
  );
  return { svc, greedy, solver };
}

const input: Tours.PlanLoopInput = {
  cacheIds: [1, 2],
  maxLinkMeters: 1500,
  completeAdventuresOnly: true,
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

  it("surfaces adventures skipped at the candidate cap as `candidate-cap` drops", async () => {
    // 50 non-AL caches already fill the cap, so adventure A1's stages can't fit
    // and are skipped whole — they must come back as candidate-cap drops.
    const fillers = Array.from({ length: 50 }, (_, i) =>
      cache(100 + i, "traditional"),
    );
    const { svc, solver } = makeService({
      mode: "auto",
      rows: [...fillers, cache(1, "Adventure Lab", "A1")],
      stages: [
        cache(1, "Adventure Lab", "A1"),
        cache(2, "Adventure Lab", "A1"),
      ],
    });
    const res = await svc.planLoop(ownerId, input);
    expect(solver.planLoop).toHaveBeenCalledOnce();
    expect(res.droppedCaches).toEqual(
      expect.arrayContaining([
        { id: 1, reason: "candidate-cap" },
        { id: 2, reason: "candidate-cap" },
      ]),
    );
    expect(res.droppedCacheIds).toEqual(expect.arrayContaining([1, 2]));
  });

  it("excludes a non-cohesive touched adventure as `unreachable` (atomic)", async () => {
    // Adventure A1's straggler stage 3 doesn't connect to the cluster's walking
    // graph → the whole adventure (incl. the selected stage 1) is excluded.
    const { svc } = makeService({
      mode: "auto",
      rows: [
        cache(1, "Adventure Lab", "A1"),
        cache(2, "traditional"),
        cache(4, "traditional"),
      ],
      stages: [
        cache(1, "Adventure Lab", "A1"),
        cache(3, "Adventure Lab", "A1"),
      ],
      unreachableIds: [3],
    });
    const res = await svc.planLoop(ownerId, input);
    expect(res.droppedCaches).toEqual(
      expect.arrayContaining([
        { id: 1, reason: "unreachable" },
        { id: 3, reason: "unreachable" },
      ]),
    );
  });

  it("keeps the selected stage when completeAdventuresOnly is off", async () => {
    const { svc, solver } = makeService({
      mode: "auto",
      rows: [cache(1, "Adventure Lab", "A1"), cache(2, "traditional")],
      stages: [
        cache(1, "Adventure Lab", "A1"),
        cache(3, "Adventure Lab", "A1"),
      ],
      unreachableIds: [3],
    });
    const nonAtomic = {
      ...input,
      completeAdventuresOnly: false,
    } as unknown as Tours.PlanLoopInput;
    const res = await svc.planLoop(ownerId, nonAtomic);
    // The selected stage 1 stays in the plan; nothing is dropped as unreachable.
    expect(solver.planLoop).toHaveBeenCalledWith(
      ownerId,
      expect.objectContaining({ cacheIds: expect.arrayContaining([1]) }),
    );
    expect(res.droppedCaches ?? []).not.toContainEqual({
      id: 1,
      reason: "unreachable",
    });
  });
});
