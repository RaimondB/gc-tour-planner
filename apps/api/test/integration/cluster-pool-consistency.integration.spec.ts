// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Layer consistency (the rule): "whatever is shown on the map after filtering
// is exactly what gets clustered." The map and the tour planner must derive
// their cache set from the SAME filters. This pins that invariant at the seam
// where it broke — `prepareClusteringContext`'s discovery pool must equal
// `CachesRepository.find()` for the same filter set (modulo the deliberate
// `excludeFound:true` the pool always applies). Real PostGIS, no mocks.

import { Logger } from "@nestjs/common";
import { Tours } from "@gctp/shared";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import { CacheLanduseRepository } from "../../src/caches/cache-landuse.repository.js";
import {
  type OsrmClient,
  type OsrmLeg,
  type OsrmMatrixEntry,
} from "../../src/routing/osrm.client.js";
import { RoutingRepository } from "../../src/routing/routing.repository.js";
import { prepareClusteringContext } from "../../src/tours/strategies/greedy/clustering/context.js";
import { makeCachesService, makeOsrmVersion } from "./integration-helpers.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

function haversine(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Straight-line OSRM stand-in (×1.3 detour) — enough to build a walk graph. */
class FakeOsrmClient implements OsrmClient {
  async route(
    from: [number, number],
    to: [number, number],
  ): Promise<OsrmLeg | null> {
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
  async routeAlternatives(
    from: [number, number],
    to: [number, number],
  ): Promise<OsrmLeg[]> {
    const leg = await this.route(from, to);
    return leg ? [leg] : [];
  }
  async routeMulti(): Promise<OsrmLeg | null> {
    return null;
  }
  async nearest(point: [number, number]): Promise<[number, number] | null> {
    return point;
  }
}

describe("cluster pool == map-visible set (layer consistency)", () => {
  let pg: PostgresFixture;
  let ownerId: string;

  // Everything within a few hundred metres so the pool is one neighbourhood.
  const CENTER: [number, number] = [5.0005, 52.0005];

  async function seedCache(
    code: string,
    type: string,
    solved: boolean,
    lng: number,
    lat: number,
  ): Promise<number> {
    const row = await pg.db
      .insertInto("caches")
      .values({
        owner_id: ownerId,
        source: "gpx",
        source_id: code,
        code,
        type,
        name: code,
        location: sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
        published_location: sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
        solved,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return Number(row.id);
  }

  async function addStages(cacheId: number, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await pg.db
        .insertInto("additional_waypoints")
        .values({
          cache_id: cacheId,
          type: "stages",
          location: sql<string>`ST_SetSRID(ST_MakePoint(5.0, 52.0), 4326)::geography`,
          note: null,
        })
        .execute();
    }
  }

  beforeAll(async () => {
    pg = await startPostgres();
    const user = await pg.db
      .insertInto("users")
      .values({ email: "consistency@gctp.local", display_name: "Consistency" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;

    // A deliberately mixed neighbourhood that exercises every filter that was
    // diverging: a solved + an unsolved Mystery, a mini + a full Multi, and a
    // tool-required cache.
    await seedCache("GCSOLV", "Mystery", true, 5.0, 52.0);
    await seedCache("GCUNSOL", "Mystery", false, 5.001, 52.0);
    const mini = await seedCache("GCMINI", "Multi", false, 5.0, 52.001);
    await addStages(mini, 1); // classifyMulti → "mini"
    const full = await seedCache("GCFULL", "Multi", false, 5.001, 52.001);
    await addStages(full, 3); // classifyMulti → "full"
    const tool = await seedCache(
      "GCTOOL",
      "Traditional",
      false,
      5.0005,
      52.0005,
    );
    await pg.db
      .insertInto("cache_attributes")
      .values({ cache_id: tool, attr_id: 51, positive: true }) // "special tool required"
      .execute();
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("find() applies solvedMysteriesOnly + multiSubtype + hideToolCaches", async () => {
    const repo = new CachesRepository(pg.db);
    const visible = await repo.find({
      ownerId,
      center: CENTER,
      radiusM: 5000,
      solvedMysteriesOnly: true,
      multiSubtype: "mini",
      hideToolCaches: true,
    });
    // Solved mystery + mini multi survive; unsolved mystery, full multi, and
    // the tool cache are filtered out.
    expect(visible.map((c) => c.code).sort()).toEqual(["GCMINI", "GCSOLV"]);
  });

  it("the discovery pool equals find() for the same filters (the invariant)", async () => {
    const repo = new CachesRepository(pg.db);
    const caches = makeCachesService(pg.db);
    const hardFilters: Tours.HardFilters = {
      solvedMysteriesOnly: true,
      multiSubtype: "mini",
      hideToolCaches: true,
    };

    // What the map shows for this filter (the planner pool always also forces
    // excludeFound:true, so mirror that here — none of the seeds are found).
    const mapVisible = await repo.find({
      ownerId,
      center: CENTER,
      radiusM: 5000,
      ...hardFilters,
      excludeFound: true,
    });

    const planInput = Tours.PlanInput.parse({
      center: CENTER,
      radiusM: 5000,
      hardFilters,
      softPreferences: {},
    });

    const ctx = await prepareClusteringContext(ownerId, planInput, {
      caches,
      cachesRepo: repo,
      cacheLanduse: new CacheLanduseRepository(pg.db),
      routingRepo: new RoutingRepository(pg.db),
      osrm: new FakeOsrmClient(),
      osrmVersion: makeOsrmVersion(),
      logger: new Logger("consistency-test"),
    });
    expect(ctx).not.toBeNull();

    const poolCodes = ctx!.pool.map((c) => c.code).sort();
    const visibleCodes = mapVisible.map((c) => c.code).sort();
    // The exact invariant: the planner clusters precisely the visible set.
    expect(poolCodes).toEqual(visibleCodes);
    expect(poolCodes).toEqual(["GCMINI", "GCSOLV"]);
    // And none of the filtered-out caches leaked into the pool.
    expect(poolCodes).not.toContain("GCUNSOL");
    expect(poolCodes).not.toContain("GCFULL");
    expect(poolCodes).not.toContain("GCTOOL");
  });
});
