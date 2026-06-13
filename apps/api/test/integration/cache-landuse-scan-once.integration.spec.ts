// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pins the scan-once contract of `populate_cache_landuse_in_bbox` (migration
// 1779720000000): each cache is scanned for landuse-polygon membership exactly
// once, stamped via `caches.landuse_scanned_at`, and an already-scanned region
// is a no-op instead of re-running the spatial join every discovery. Correct-
// ness must survive that optimisation: never drop a real membership, always
// pick up a newly-added cache, and re-scan a cache whose stamp was reset (the
// move-invalidation path). Real PostGIS, no mocks (per CLAUDE.md).

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CacheLanduseRepository } from "../../src/caches/cache-landuse.repository.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

describe("populate_cache_landuse_in_bbox (scan-once)", () => {
  let pg: PostgresFixture;
  let repo: CacheLanduseRepository;
  let ownerId: string;
  // A 'forest' polygon covering [5.00,52.00] → [5.01,52.01].
  const BBOX = { minLng: 4.99, minLat: 51.99, maxLng: 5.02, maxLat: 52.02 };

  async function seedCache(
    code: string,
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
        type: "Traditional",
        name: code,
        location: sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
        published_location: sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
        solved: false,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return Number(row.id);
  }

  async function scannedAt(cacheId: number): Promise<Date | null> {
    const row = await pg.db
      .selectFrom("caches")
      .select("landuse_scanned_at")
      .where("id", "=", cacheId)
      .executeTakeFirstOrThrow();
    return row.landuse_scanned_at;
  }

  const pop = () =>
    repo.populateForBbox(BBOX.minLng, BBOX.minLat, BBOX.maxLng, BBOX.maxLat);

  beforeAll(async () => {
    pg = await startPostgres();
    repo = new CacheLanduseRepository(pg.db);
    const user = await pg.db
      .insertInto("users")
      .values({ email: "landuse@gctp.local", display_name: "Landuse" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;
    await pg.db
      .insertInto("landuse_polygons")
      .values({
        osm_id: 1,
        osm_type: "w",
        kind: "forest",
        geom: sql<string>`ST_Multi(ST_MakeEnvelope(5.0, 52.0, 5.01, 52.01, 4326))`,
      })
      .execute();
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("scans, stamps, and is a no-op on the second run", async () => {
    const inside = await seedCache("GCIN", 5.005, 52.005);
    // Inside the BBOX but outside the forest polygon.
    const outside = await seedCache("GCOUT", 5.015, 52.015);

    // First populate scans both in-bbox caches: 'inside' gets forest, and BOTH
    // get stamped — including 'outside', which fell in no polygon (the case the
    // old function could not distinguish and kept re-scanning).
    const firstInserted = await pop();
    expect(firstInserted).toBe(1);
    const kinds = await repo.kindsByCacheId([inside, outside]);
    expect(kinds.get(inside)).toEqual(["forest"]);
    expect(kinds.get(outside)).toBeUndefined();
    expect(await scannedAt(inside)).not.toBeNull();
    // 'outside' is outside the polygon but INSIDE the bbox → scanned + stamped.
    expect(await scannedAt(outside)).not.toBeNull();

    // Second run over the same region: nothing unscanned → no work, no inserts.
    expect(await pop()).toBe(0);
  });

  it("picks up a cache added after the region was first scanned", async () => {
    const late = await seedCache("GCLATE", 5.006, 52.006);
    expect(await scannedAt(late)).toBeNull(); // fresh insert → unscanned

    const inserted = await pop();
    expect(inserted).toBe(1); // only the new cache is scanned
    expect((await repo.kindsByCacheId([late])).get(late)).toEqual(["forest"]);
    expect(await scannedAt(late)).not.toBeNull();
  });

  it("re-scans a cache whose stamp was reset (move invalidation)", async () => {
    const moved = await seedCache("GCMOVE", 5.007, 52.007);
    await pop(); // scan + stamp
    expect(await scannedAt(moved)).not.toBeNull();

    // Simulate a relocation: membership deleted + stamp reset (what
    // clearSolved / gpx relocation do in-transaction).
    await pg.db
      .deleteFrom("cache_landuse")
      .where("cache_id", "=", moved)
      .execute();
    await pg.db
      .updateTable("caches")
      .set({ landuse_scanned_at: null })
      .where("id", "=", moved)
      .execute();

    const inserted = await pop();
    expect(inserted).toBe(1); // re-scanned
    expect((await repo.kindsByCacheId([moved])).get(moved)).toEqual(["forest"]);
    expect(await scannedAt(moved)).not.toBeNull();
  });
});
