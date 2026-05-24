// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Geo, Landuse } from "@gctp/shared";
import { GpxRepository } from "../../src/gpx/gpx.repository.js";
import { GpxService } from "../../src/gpx/gpx.service.js";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import { CachesService } from "../../src/caches/caches.service.js";
import { OsmRepository } from "../../src/osm/osm.repository.js";
import { OsmService } from "../../src/osm/osm.service.js";
import type {
  FetchedLanduse,
  OverpassClient,
} from "../../src/osm/overpass.client.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../../packages/shared/test/fixtures/sample-pq.gpx",
    import.meta.url,
  ),
);

/**
 * Hand-built tiny "forest" polygon that contains 5.1214,52.0907 (cache
 * GCAAA111 from sample-pq.gpx) but NOT 5.13,52.095 (GCBBB222). Used to
 * verify the contexts hard filter without touching real Overpass.
 */
const FAKE_FOREST: FetchedLanduse = {
  osmSource: "way:999001",
  kind: "forest",
  polygon: {
    type: "Polygon",
    coordinates: [
      [
        [5.115, 52.085],
        [5.125, 52.085],
        [5.125, 52.094],
        [5.115, 52.094],
        [5.115, 52.085],
      ],
    ],
  },
};

class FakeOverpass implements OverpassClient {
  calls: Geo.BoundingBox[] = [];
  responses: FetchedLanduse[][] = [];

  constructor(initial: FetchedLanduse[][]) {
    this.responses = [...initial];
  }

  async fetchLanduse(bbox: Geo.BoundingBox): Promise<FetchedLanduse[]> {
    this.calls.push(bbox);
    return this.responses.shift() ?? [];
  }
}

describe("M3 OSM landuse integration (PostGIS via Testcontainers)", () => {
  let pg: PostgresFixture;
  let ownerId: string;
  let osmService: OsmService;
  let cachesService: CachesService;
  let gpxService: GpxService;
  let overpass: FakeOverpass;

  beforeAll(async () => {
    pg = await startPostgres();

    const user = await pg.db
      .insertInto("users")
      .values({ email: "m3@gctp.local", display_name: "M3 Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;

    overpass = new FakeOverpass([[FAKE_FOREST]]);
    osmService = new OsmService(new OsmRepository(pg.db), overpass);
    cachesService = new CachesService(new CachesRepository(pg.db));
    gpxService = new GpxService(new GpxRepository(pg.db));

    // Seed caches so the contexts filter has something to test against.
    const xml = readFileSync(fixturePath, "utf8");
    await gpxService.ingest(ownerId, "sample-pq.gpx", xml);
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("first /landuse call refreshes Overpass for missing cell; second is cached", async () => {
    const bbox = { minLng: 5.11, minLat: 52.08, maxLng: 5.14, maxLat: 52.1 };

    const first = await osmService.listLanduse({ bbox });
    expect(first.type).toBe("FeatureCollection");
    expect(first.features).toHaveLength(1);
    expect(first.features[0]?.properties.kind).toBe("forest");
    expect(overpass.calls).toHaveLength(1);

    const second = await osmService.listLanduse({ bbox });
    expect(second.features).toHaveLength(1);
    // No new Overpass call — fully served from cache.
    expect(overpass.calls).toHaveLength(1);
  });

  it("filters by kind in the projection", async () => {
    const bbox = { minLng: 5.11, minLat: 52.08, maxLng: 5.14, maxLat: 52.1 };
    const onlyParks = await osmService.listLanduse({
      bbox,
      kinds: ["park"],
    } as Landuse.LanduseQuery);
    expect(onlyParks.features).toEqual([]);
  });

  it("contexts hard-filter on /caches uses ST_Contains over the cached polygons", async () => {
    // GCAAA111 (5.1214,52.0907) is inside FAKE_FOREST; GCBBB222 (5.13,52.095) is not.
    const inForest = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
      contexts: ["forest"],
    } as never);
    expect(inForest.caches.map((c) => c.code)).toEqual(["GCAAA111"]);

    const inPark = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
      contexts: ["park"],
    } as never);
    expect(inPark.caches).toEqual([]);
  });
});
