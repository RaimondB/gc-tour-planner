// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Caches, Geo, Routing, Tours } from "@gctp/shared";
import type { CachesService } from "../../../caches/caches.service.js";
import type { RoutingService } from "../../../routing/routing.service.js";
import type { OsrmClient } from "../../../routing/osrm.client.js";
import type { GreedyTspPlanner } from "../greedy/greedy-tsp-planner.js";
import { SolverTourPlanner } from "./solver-tour-planner.js";
import type {
  SolverClient,
  SolverPlanRequest,
  SolverPlanResponse,
} from "./solver-client.js";

/**
 * Determinism contract: with all upstream calls stubbed to fixed values, the
 * SolverTourPlanner must return the exact same PlanResult on repeated runs
 * with the same input. The real sidecar's determinism is owned by the seeded
 * Timefold solver (see infra/solver/application.properties); this test pins
 * the Nest-side glue — request shape, post-processing, score breakdown.
 */
describe("SolverTourPlanner — determinism", () => {
  const ownerId = "11111111-1111-1111-1111-111111111111";

  const caches: Caches.CacheDTO[] = [
    cache(101, 4.9, 52.4),
    cache(102, 4.91, 52.405),
    cache(103, 4.92, 52.41),
  ];

  const matrix: Routing.Matrix = {
    profile: "foot",
    cacheIds: [101, 102, 103],
    legs: [
      [
        { meters: 0, seconds: 0 },
        { meters: 800, seconds: 720 },
        { meters: 1700, seconds: 1500 },
      ],
      [
        { meters: 800, seconds: 720 },
        { meters: 0, seconds: 0 },
        { meters: 900, seconds: 800 },
      ],
      [
        { meters: 1700, seconds: 1500 },
        { meters: 900, seconds: 800 },
        { meters: 0, seconds: 0 },
      ],
    ],
  };

  const stubLeg = (meters: number, seconds: number): Routing.Leg => ({
    fromCacheId: 0,
    toCacheId: 0,
    profile: "foot",
    meters,
    seconds,
    geometry: line([
      [0, 0],
      [1, 1],
    ]),
  });

  let cachesService: CachesService;
  let routingService: RoutingService;
  let osrmClient: OsrmClient;
  let greedy: GreedyTspPlanner;
  let solverClient: SolverClient;
  let planner: SolverTourPlanner;

  beforeEach(() => {
    cachesService = {
      findByIds: vi.fn().mockResolvedValue(caches),
    } as unknown as CachesService;

    routingService = {
      getMatrix: vi.fn().mockResolvedValue(matrix),
      getLeg: vi.fn().mockResolvedValue(stubLeg(900, 800)),
    } as unknown as RoutingService;

    osrmClient = {
      route: vi.fn().mockResolvedValue({
        meters: 150,
        seconds: 180,
        geometry: line([
          [0, 0],
          [0.001, 0.001],
        ]),
      }),
      // Loop-aware leg picker in planLoop uses /route?alternatives — the
      // stub returns a single-element array (primary only) which is the
      // common real-world case for short urban legs.
      routeAlternatives: vi.fn().mockResolvedValue([
        {
          meters: 150,
          seconds: 180,
          geometry: line([
            [0, 0],
            [0.001, 0.001],
          ]),
        },
      ]),
      // routeMulti is the via-waypoint nudge fallback. Returning the same
      // primary geometry mirrors OSRM "snap back to the same road when no
      // parallel exists" — keeps the spec deterministic.
      routeMulti: vi.fn().mockResolvedValue({
        meters: 150,
        seconds: 180,
        geometry: line([
          [0, 0],
          [0.001, 0.001],
        ]),
      }),
      table: vi.fn(),
      nearest: vi.fn().mockResolvedValue([0, 0]),
    };

    greedy = {
      discoverClusters: vi.fn(),
    } as unknown as GreedyTspPlanner;

    solverClient = {
      plan: vi
        .fn()
        .mockImplementation(
          async (req: SolverPlanRequest): Promise<SolverPlanResponse> => {
            // Deterministic stub: visit caches in ascending id order regardless
            // of the inbound matrix; totals echo the matrix legs so the
            // scoreBreakdown numbers in the assertion stay easy to read.
            const ordered = req.caches
              .map((c) => c.id)
              .slice()
              .sort((a, b) => a - b);
            return {
              orderedCacheIds: ordered,
              totalMeters: 1234.0,
              totalSeconds: 2345.0,
              visitedCount: ordered.length,
            };
          },
        ),
      health: vi.fn().mockResolvedValue(true),
    };

    planner = new SolverTourPlanner(
      greedy,
      cachesService,
      routingService,
      osrmClient,
      solverClient,
    );
  });

  const input: Tours.PlanLoopInput = {
    cacheIds: [101, 102, 103],
    distanceBudgetMeters: 8000,
    timePerCacheMinutes: 5,
    startPreference: "parking-waypoint",
  };

  it("returns the same PlanResult on repeated runs", async () => {
    const a = await planner.planLoop(ownerId, input);
    const b = await planner.planLoop(ownerId, input);
    expect(b).toEqual(a);
  });

  it("uses solver-supplied orderedCacheIds verbatim", async () => {
    const res = await planner.planLoop(ownerId, input);
    expect(res.orderedCacheIds).toEqual([101, 102, 103]);
    // scoreBreakdown carries through the solver-reported totals so the UI
    // can show "solver picked this many caches" without re-running the model.
    expect(res.scoreBreakdown.visitedCount).toBe(3);
    expect(res.scoreBreakdown.solverTotalMeters).toBe(1234.0);
  });

  it("delegates discoverClusters to the greedy planner", async () => {
    const planInput = {} as Tours.PlanInput;
    const sentinel = {
      candidates: [],
      diagnostics: {
        epsilonMeters: 0,
        poolSize: 0,
        components: [],
        cacheConnectivity: [],
      },
    } satisfies Tours.DiscoverClustersResult;
    (greedy.discoverClusters as ReturnType<typeof vi.fn>).mockResolvedValue(
      sentinel,
    );
    const result = await planner.discoverClusters(ownerId, planInput);
    expect(result).toBe(sentinel);
    expect(greedy.discoverClusters).toHaveBeenCalledWith(ownerId, planInput);
  });

  it("classifies a solver-omitted but reachable cache as a `budget` drop", async () => {
    // Solver returns only 2 of the 3 candidates (count-vs-length trade-off).
    // Cache 103 is fully reachable, so the omission reads as a budget choice.
    (solverClient.plan as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      orderedCacheIds: [101, 102],
      totalMeters: 1000,
      totalSeconds: 1000,
      visitedCount: 2,
    });
    const res = await planner.planLoop(ownerId, input);
    expect(res.orderedCacheIds).not.toContain(103);
    expect(res.droppedCacheIds).toContain(103);
    expect(res.droppedCaches).toContainEqual({ id: 103, reason: "budget" });
    // The two lists stay in lock-step.
    expect(res.droppedCaches.map((d) => d.id).sort()).toEqual(
      [...res.droppedCacheIds].sort(),
    );
  });

  it("classifies a solver-omitted unrouteable cache as `unreachable`", async () => {
    // 103 has no finite matrix neighbour (null to/from everyone), but 101↔102
    // keep the loop viable. The solver omits 103 → reason `unreachable`.
    const brokenMatrix: Routing.Matrix = {
      ...matrix,
      legs: matrix.legs.map((row, i) =>
        row.map((cell, j) => (i === 2 || j === 2 ? null : cell)),
      ),
    };
    (
      routingService.getMatrix as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(brokenMatrix);
    (solverClient.plan as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      orderedCacheIds: [101, 102],
      totalMeters: 1000,
      totalSeconds: 1000,
      visitedCount: 2,
    });
    const res = await planner.planLoop(ownerId, input);
    expect(res.droppedCaches).toContainEqual({
      id: 103,
      reason: "unreachable",
    });
  });

  it("posts the matrix with null cells preserved for unreachable pairs", async () => {
    // Replace one cell with null and confirm the request mirrors it.
    const brokenMatrix: Routing.Matrix = {
      ...matrix,
      legs: matrix.legs.map((row, i) =>
        row.map((cell, j) => (i === 0 && j === 2 ? null : cell)),
      ),
    };
    (
      routingService.getMatrix as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(brokenMatrix);
    await planner.planLoop(ownerId, input);
    const req = (solverClient.plan as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as SolverPlanRequest;
    expect(req.matrixMeters[0]![2]).toBeNull();
    expect(req.matrixSeconds[0]![2]).toBeNull();
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function cache(id: number, lng: number, lat: number): Caches.CacheDTO {
  return {
    id,
    source: "gpx",
    sourceId: `gpx-${id}`,
    code: `GC${id}`,
    type: "traditional",
    name: `Cache ${id}`,
    location: { type: "Point", coordinates: [lng, lat] },
    difficulty: 1.5,
    terrain: 1.5,
    size: "regular",
    archived: false,
    attributeIds: [],
    parkingPoints: [[lng - 0.001, lat - 0.001]],
    foundByMe: false,
  };
}

function line(coords: [number, number][]): Geo.GeoJsonLineString {
  return { type: "LineString", coordinates: coords };
}
