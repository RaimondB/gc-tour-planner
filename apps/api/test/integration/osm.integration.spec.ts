// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Landuse } from "@gctp/shared";
import { sql } from "kysely";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import { CachesService } from "../../src/caches/caches.service.js";
import { LanduseRepository } from "../../src/osm/landuse.repository.js";
import { OsmService } from "../../src/osm/osm.service.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";
import { makeGpxService } from "./integration-helpers.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../../packages/shared/test/fixtures/sample-pq.gpx",
    import.meta.url,
  ),
);

/**
 * Hand-built tiny "forest" polygon that contains 5.1214,52.0907 (cache
 * GCAAA111 from sample-pq.gpx) but NOT 5.13,52.095 (GCBBB222). Used to
 * verify the contexts hard filter against the osm2pgsql-fed
 * `landuse_polygons` table (ADR-0009 — no more Overpass mock).
 */
const FAKE_FOREST_GEOJSON = JSON.stringify({
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [5.115, 52.085],
        [5.125, 52.085],
        [5.125, 52.094],
        [5.115, 52.094],
        [5.115, 52.085],
      ],
    ],
  ],
});

describe("OSM landuse integration (PostGIS via Testcontainers)", () => {
  let pg: PostgresFixture;
  let ownerId: string;
  let osmService: OsmService;
  let cachesService: CachesService;
  let gpxService: GpxService;

  beforeAll(async () => {
    pg = await startPostgres();

    const user = await pg.db
      .insertInto("users")
      .values({ email: "m3@gctp.local", display_name: "M3 Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;

    // Seed a single landuse polygon — same shape osm2pgsql would produce.
    // osm_type='w' (way), osm_id is arbitrary for the test.
    await sql`
      INSERT INTO landuse_polygons (osm_id, osm_type, kind, geom)
      VALUES (
        999001,
        'w',
        'forest',
        ST_SetSRID(ST_GeomFromGeoJSON(${FAKE_FOREST_GEOJSON}), 4326)
      )
    `.execute(pg.db);

    osmService = new OsmService(new LanduseRepository(pg.db));
    cachesService = new CachesService(new CachesRepository(pg.db));
    gpxService = makeGpxService(pg.db);

    // Seed caches so the contexts filter has something to test against.
    const xml = readFileSync(fixturePath, "utf8");
    await gpxService.ingest(ownerId, "sample-pq.gpx", xml);
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("/landuse returns polygons intersecting the bbox", async () => {
    const bbox = { minLng: 5.11, minLat: 52.08, maxLng: 5.14, maxLat: 52.1 };

    const result = await osmService.listLanduse({ bbox });
    expect(result.type).toBe("FeatureCollection");
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.properties.kind).toBe("forest");
  });

  it("filters by kind in the projection", async () => {
    const bbox = { minLng: 5.11, minLat: 52.08, maxLng: 5.14, maxLat: 52.1 };
    const onlyParks = await osmService.listLanduse({
      bbox,
      kinds: ["park"],
    } as Landuse.LanduseQuery);
    expect(onlyParks.features).toEqual([]);
  });

  it("contexts hard-filter on /caches uses ST_Contains over landuse_polygons", async () => {
    // GCAAA111 (5.1214,52.0907) is inside the forest; GCBBB222 (5.13,52.095) is not.
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
