// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type OsrmClient,
  type OsrmLeg,
  type OsrmMatrixEntry,
} from "../../src/routing/osrm.client.js";
import { RoutingRepository } from "../../src/routing/routing.repository.js";
import { RoutingService } from "../../src/routing/routing.service.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";
import { makeGpxService, makeOsrmVersion } from "./integration-helpers.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../../packages/shared/test/fixtures/sample-pq.gpx",
    import.meta.url,
  ),
);

/**
 * Records every call so we can assert "did we hit OSRM or serve from cache?".
 * Deterministic stub: distance = great-circle * 1.3 (typical walking detour),
 * duration = distance / 1.4 m/s.
 */
class FakeOsrmClient implements OsrmClient {
  routeCalls: { from: [number, number]; to: [number, number] }[] = [];
  tableCalls: { coords: readonly [number, number][] }[] = [];

  async route(
    from: [number, number],
    to: [number, number],
  ): Promise<OsrmLeg | null> {
    this.routeCalls.push({ from, to });
    const meters = haversine(from, to) * 1.3;
    return {
      meters,
      seconds: meters / 1.4,
      geometry: { type: "LineString", coordinates: [from, to] },
    };
  }

  async table(
    coords: readonly [number, number][],
  ): Promise<(OsrmMatrixEntry | null)[][]> {
    this.tableCalls.push({ coords });
    const n = coords.length;
    const out: (OsrmMatrixEntry | null)[][] = [];
    for (let i = 0; i < n; i += 1) {
      const row: (OsrmMatrixEntry | null)[] = [];
      for (let j = 0; j < n; j += 1) {
        if (i === j) {
          row.push({ meters: 0, seconds: 0 });
        } else {
          const m = haversine(coords[i]!, coords[j]!) * 1.3;
          row.push({ meters: m, seconds: m / 1.4 });
        }
      }
      out.push(row);
    }
    return out;
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

describe("M4-α routing integration (PostGIS via Testcontainers)", () => {
  let pg: PostgresFixture;
  let ownerId: string;
  let osrm: FakeOsrmClient;
  let routing: RoutingService;
  let cacheIds: number[];

  beforeAll(async () => {
    pg = await startPostgres();

    const user = await pg.db
      .insertInto("users")
      .values({ email: "m4@gctp.local", display_name: "M4 Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;

    const gpxService = makeGpxService(pg.db);
    const xml = readFileSync(fixturePath, "utf8");
    await gpxService.ingest(ownerId, "sample-pq.gpx", xml);

    osrm = new FakeOsrmClient();
    routing = new RoutingService(
      new RoutingRepository(pg.db),
      osrm,
      makeOsrmVersion(),
    );

    const rows = await pg.db
      .selectFrom("caches")
      .select(["id"])
      .where("owner_id", "=", ownerId)
      .orderBy("id")
      .execute();
    cacheIds = rows.map((r) => Number(r.id));
    expect(cacheIds.length).toBeGreaterThanOrEqual(2);
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("first getLeg hits OSRM and persists; second is served from cache", async () => {
    const [a, b] = cacheIds;
    osrm.routeCalls = [];

    const leg1 = await routing.getLeg(ownerId, a!, b!, "foot");
    expect(leg1).not.toBeNull();
    expect(leg1!.meters).toBeGreaterThan(0);
    expect(osrm.routeCalls).toHaveLength(1);

    const leg2 = await routing.getLeg(ownerId, a!, b!, "foot");
    expect(leg2?.meters).toBe(leg1!.meters);
    // No new OSRM call — fully cached.
    expect(osrm.routeCalls).toHaveLength(1);
  });

  it("self-loop returns trivial zero-length without calling OSRM", async () => {
    osrm.routeCalls = [];
    const [a] = cacheIds;
    const leg = await routing.getLeg(ownerId, a!, a!, "foot");
    expect(leg).not.toBeNull();
    expect(leg!.meters).toBe(0);
    expect(leg!.seconds).toBe(0);
    expect(osrm.routeCalls).toHaveLength(0);
  });

  it("getMatrix on N caches makes one /table call; diagonals are zero", async () => {
    osrm.tableCalls = [];
    const matrix = await routing.getMatrix(ownerId, cacheIds, "foot");
    expect(matrix.cacheIds).toEqual(cacheIds);
    expect(matrix.legs).toHaveLength(cacheIds.length);
    for (let i = 0; i < cacheIds.length; i += 1) {
      expect(matrix.legs[i]).toHaveLength(cacheIds.length);
      expect(matrix.legs[i]?.[i]).toEqual({ meters: 0, seconds: 0 });
    }
    // /table fired at most once (zero if every pair was cached already).
    expect(osrm.tableCalls.length).toBeLessThanOrEqual(1);
  });

  it("rejects a cache not owned by the user", async () => {
    const other = await pg.db
      .insertInto("users")
      .values({ email: "other-m4@gctp.local", display_name: "Other" })
      .returning("id")
      .executeTakeFirstOrThrow();

    await expect(
      routing.getLeg(other.id, cacheIds[0]!, cacheIds[1]!, "foot"),
    ).rejects.toThrow(/not found/i);
  });
});
