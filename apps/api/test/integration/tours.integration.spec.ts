// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Tours } from "@gctp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import { CachesService } from "../../src/caches/caches.service.js";
import { CacheLanduseRepository } from "../../src/caches/cache-landuse.repository.js";
import {
  type OsrmClient,
  type OsrmLeg,
  type OsrmMatrixEntry,
} from "../../src/routing/osrm.client.js";
import { RoutingRepository } from "../../src/routing/routing.repository.js";
import { RoutingService } from "../../src/routing/routing.service.js";
import { GreedyTspPlanner } from "../../src/tours/strategies/greedy/greedy-tsp-planner.js";
import { ParkingFacilitiesRepository } from "../../src/osm/parking-facilities.repository.js";
import { CarRoadsRepository } from "../../src/osm/car-roads.repository.js";
import { LanduseProfilesRepository } from "../../src/landuse-profiles/landuse-profiles.repository.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";
import {
  fakeComputePool,
  fakeWalkingQueue,
  makeOsrmVersion,
} from "./integration-helpers.js";

class FakeOsrmClient implements OsrmClient {
  routeCalls = 0;
  tableCalls = 0;

  async route(
    from: [number, number],
    to: [number, number],
  ): Promise<OsrmLeg | null> {
    this.routeCalls += 1;
    const m = haversine(from, to) * 1.3;
    return {
      meters: m,
      seconds: m / 1.4,
      geometry: { type: "LineString", coordinates: [from, to] },
    };
  }

  async table(
    coords: readonly [number, number][],
  ): Promise<(OsrmMatrixEntry | null)[][]> {
    this.tableCalls += 1;
    return coords.map((a, i) =>
      coords.map((b, j) =>
        i === j
          ? { meters: 0, seconds: 0 }
          : {
              meters: haversine(a, b) * 1.3,
              seconds: (haversine(a, b) * 1.3) / 1.4,
            },
      ),
    );
  }

  // The loop-aware leg picker (Pass 2) asks for alternatives; the fake offers
  // exactly the primary straight-line leg — enough for the planner to pick.
  async routeAlternatives(
    from: [number, number],
    to: [number, number],
  ): Promise<OsrmLeg[]> {
    const leg = await this.route(from, to);
    return leg ? [leg] : [];
  }

  // Stitch the via-coords into one polyline; meters = sum of straight legs.
  async routeMulti(
    coords: readonly [number, number][],
  ): Promise<OsrmLeg | null> {
    if (coords.length < 2) return null;
    let meters = 0;
    for (let i = 1; i < coords.length; i += 1) {
      meters += haversine(coords[i - 1]!, coords[i]!) * 1.3;
    }
    return {
      meters,
      seconds: meters / 1.4,
      geometry: { type: "LineString", coordinates: [...coords] },
    };
  }

  // No road graph in the fake — snapping is a no-op (point is already routable).
  async nearest(point: [number, number]): Promise<[number, number] | null> {
    return point;
  }
}

function haversine(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/**
 * Insert a cache directly via SQL — bypasses GPX parsing so the test controls
 * exactly which cluster shape lands in the DB.
 */
async function insertCache(
  fixture: PostgresFixture,
  ownerId: string,
  code: string,
  lng: number,
  lat: number,
  opts: { parkingAt?: [number, number] } = {},
): Promise<number> {
  const { sql } = await import("kysely");
  const row = await fixture.db
    .insertInto("caches")
    .values({
      owner_id: ownerId,
      source: "gpx",
      source_id: code,
      code,
      type: "Traditional",
      name: `${code} test`,
      location: sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
      raw: { test: true },
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const id = Number(row.id);
  if (opts.parkingAt) {
    const [plng, plat] = opts.parkingAt;
    await fixture.db
      .insertInto("additional_waypoints")
      .values({
        cache_id: id,
        type: "parking",
        location: sql<string>`ST_SetSRID(ST_MakePoint(${plng}, ${plat}), 4326)::geography`,
        note: "test parking",
      })
      .execute();
  }
  return id;
}

describe("M5-α tour planner integration (PostGIS via Testcontainers)", () => {
  let pg: PostgresFixture;
  let ownerId: string;
  let osrm: FakeOsrmClient;
  let planner: GreedyTspPlanner;
  let center: [number, number];
  let clusterCacheIds: number[];

  beforeAll(async () => {
    pg = await startPostgres();

    const user = await pg.db
      .insertInto("users")
      .values({ email: "m5@gctp.local", display_name: "M5 Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;

    // Tight 6-cache cluster around (5.12, 52.09); spacing ~150-300m so the
    // clusterer groups them (spacing chosen for the legacy DBSCAN ε ~267m).
    center = [5.12, 52.09];
    const offsets: [number, number][] = [
      [0.0, 0.0],
      [0.002, 0.0],
      [0.0, 0.002],
      [0.002, 0.002],
      [0.001, 0.001],
      [0.003, 0.001],
    ];
    clusterCacheIds = [];
    for (let i = 0; i < offsets.length; i += 1) {
      const [dlng, dlat] = offsets[i]!;
      const id = await insertCache(
        pg,
        ownerId,
        `GCM5A${i.toString().padStart(2, "0")}`,
        center[0] + dlng,
        center[1] + dlat,
        // First cache gets a PQ parking waypoint co-located with the cluster
        // so /tours/plan picks the 'pq' parking type by default.
        i === 0
          ? { parkingAt: [center[0] + 0.0005, center[1] + 0.0005] }
          : undefined,
      );
      clusterCacheIds.push(id);
    }

    // A lone cache far away — should NOT be picked up by the clusterer as part of
    // the cluster (would be noise).
    await insertCache(pg, ownerId, "GCM5LONE", 5.3, 52.2);

    const cachesRepo = new CachesRepository(pg.db);
    const cachesService = new CachesService(cachesRepo, fakeWalkingQueue());
    const routingRepo = new RoutingRepository(pg.db);
    const osrmVersion = makeOsrmVersion();
    osrm = new FakeOsrmClient();
    const routing = new RoutingService(routingRepo, osrm, osrmVersion);
    planner = new GreedyTspPlanner(
      cachesService,
      cachesRepo,
      new CacheLanduseRepository(pg.db),
      routing,
      routingRepo,
      osrm,
      osrmVersion,
      new ParkingFacilitiesRepository(pg.db),
      new CarRoadsRepository(pg.db),
      new LanduseProfilesRepository(pg.db),
      fakeComputePool(),
    );
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  function planInput(
    overrides: Partial<Tours.PlanInput> = {},
  ): Tours.PlanInput {
    return {
      center,
      radiusM: 10_000,
      // Test fixture plants 6 caches; lower the floor so the cluster forms.
      // Production default is 8.
      minClusterSize: 3,
      // Fake OSRM returns haversine * 1.3 — the planted cluster spans
      // ~300 m on foot, so 1000 m is comfortably wide for the test.
      maxLinkMeters: 1_000,
      distanceBudgetMeters: 8_000,
      hardFilters: {},
      softPreferences: { clusterDensityWeight: 1, loopCompactnessWeight: 1 },
      startPreference: "parking-waypoint",
      ...overrides,
    };
  }

  it("discoverClusters returns at least one ranked candidate containing the planted cluster", async () => {
    const { candidates, diagnostics } = await planner.discoverClusters(
      ownerId,
      planInput(),
    );
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const top = candidates[0]!;
    // Every planted cache should be in the top cluster (the lone cache is noise).
    for (const id of clusterCacheIds) {
      expect(top.cacheIds).toContain(id);
    }
    expect(top.cacheIds).not.toContain(clusterCacheIds.length + 1 + 6);
    expect(top.scoreBreakdown).toHaveProperty("clusterDensity");
    expect(top.scoreBreakdown).toHaveProperty("parkingPresence");
    expect(top.scoreBreakdown).toHaveProperty("budgetFit");
    expect(top.scoreBreakdown.parkingPresence).toBe(1);
    expect(top.mstLengthMeters).toBeGreaterThan(0);
    // Diagnostics block carries the pre-trim components + per-cache nearest
    // walkable distance for the debug export. `epsilonMeters` is a legacy
    // DBSCAN-era field; the default strategy is now louvain, which reports 0.
    expect(diagnostics.epsilonMeters).toBeGreaterThanOrEqual(0);
    // The lone "far" cache is outside the 10km search radius and never
    // enters the pool — diagnostics only covers what was queried.
    expect(diagnostics.poolSize).toBe(clusterCacheIds.length);
    expect(diagnostics.components.length).toBeGreaterThanOrEqual(1);
    expect(diagnostics.cacheConnectivity.length).toBe(clusterCacheIds.length);
    // Every cluster cache has at least one walkable neighbor within ε.
    for (const conn of diagnostics.cacheConnectivity) {
      expect(conn.nearestWalkableMeters).not.toBeNull();
      expect(conn.nearestWalkableMeters!).toBeGreaterThan(0);
    }
  });

  it("discoverClusters is deterministic — same input ⇒ same output", async () => {
    const a = await planner.discoverClusters(ownerId, planInput());
    const b = await planner.discoverClusters(ownerId, planInput());
    expect(b).toEqual(a);
  });

  it("planLoop returns a closed loop visiting every supplied cache", async () => {
    const result = await planner.planLoop(ownerId, {
      cacheIds: clusterCacheIds,
      distanceBudgetMeters: 8_000,
      timePerCacheMinutes: 5,
      toolBonusMinutes: 5,
      startPreference: "parking-waypoint",
    });
    expect(result.orderedCacheIds).toHaveLength(clusterCacheIds.length);
    expect(new Set(result.orderedCacheIds)).toEqual(new Set(clusterCacheIds));
    expect(result.parking.type).toBe("pq");
    expect(result.totals.meters).toBeGreaterThan(0);
    expect(result.totals.visitMinutes).toBe(5 * clusterCacheIds.length);
    expect(result.polyline.coordinates.length).toBeGreaterThanOrEqual(
      result.orderedCacheIds.length,
    );
    // Polyline must start and end at the parking point (closed loop).
    const first = result.polyline.coordinates[0]!;
    const last =
      result.polyline.coordinates[result.polyline.coordinates.length - 1]!;
    expect(first).toEqual(result.parking.point.coordinates);
    expect(last).toEqual(result.parking.point.coordinates);
  });

  it("planLoop honors user-supplied start point", async () => {
    const start: [number, number] = [5.11, 52.085];
    const result = await planner.planLoop(ownerId, {
      cacheIds: clusterCacheIds,
      distanceBudgetMeters: 8_000,
      timePerCacheMinutes: 5,
      toolBonusMinutes: 5,
      startPreference: "user-supplied-point",
      userSuppliedStart: start,
    });
    expect(result.parking.type).toBe("user");
    expect(result.parking.point.coordinates).toEqual(start);
    expect(result.parking.fallback).toBe(false);
  });

  it("planLoop Auto picks cache-owner parking when one is reachable", async () => {
    const result = await planner.planLoop(ownerId, {
      cacheIds: clusterCacheIds,
      distanceBudgetMeters: 8_000,
      timePerCacheMinutes: 5,
      toolBonusMinutes: 5,
      startPreference: "auto",
      maxLinkMeters: 1_000,
    });
    // PQ is the first Auto source and the cluster has a co-located waypoint.
    expect(result.parking.type).toBe("pq");
    expect(result.parking.fallback).toBe(false);
  });

  it("planLoop Auto flags a fallback when no parking source is reachable", async () => {
    // Drop the only cache carrying a PQ waypoint; no parking_facilities or
    // car_roads are seeded in this fixture, so every Auto source comes up
    // empty and the planner falls back to the cluster centroid.
    const result = await planner.planLoop(ownerId, {
      cacheIds: clusterCacheIds.slice(1),
      distanceBudgetMeters: 8_000,
      timePerCacheMinutes: 5,
      toolBonusMinutes: 5,
      startPreference: "auto",
      maxLinkMeters: 1_000,
    });
    expect(result.parking.type).toBe("osrm-nearest");
    expect(result.parking.fallback).toBe(true);
  });

  it("planLoop rejects caches not owned by the user", async () => {
    const other = await pg.db
      .insertInto("users")
      .values({ email: "other-m5@gctp.local", display_name: "Other" })
      .returning("id")
      .executeTakeFirstOrThrow();

    await expect(
      planner.planLoop(other.id, {
        cacheIds: clusterCacheIds,
        distanceBudgetMeters: 8_000,
        timePerCacheMinutes: 5,
        toolBonusMinutes: 5,
        startPreference: "parking-waypoint",
      }),
    ).rejects.toThrow(/not found/i);
  });
});
