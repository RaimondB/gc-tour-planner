// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { PlacesRepository } from "../../src/osm/places.repository.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

/** Lon-degree ≈ 68.5 km at lat 52, so 0.2° ≈ 13.7 km (> the 8 km town cap),
 *  and the town↔village within a test point are deliberately co-located. */
const LAT = 52.0;
const PARK: [number, number] = [5.0, LAT];

async function seedPlace(
  pg: PostgresFixture,
  osmId: number,
  place: string,
  name: string,
  lng: number,
  lat: number,
): Promise<void> {
  await sql`
    INSERT INTO place_points (osm_id, place, name, geom)
    VALUES (${osmId}, ${place}, ${name},
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
  `.execute(pg.db);
}

describe("PlacesRepository.resolvePlaceLabel (PostGIS via Testcontainers, ADR-0036)", () => {
  let pg: PostgresFixture;
  let repo: PlacesRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    repo = new PlacesRepository(pg.db);

    // A named park (~600 m radius) centred on PARK.
    await sql`
      INSERT INTO landuse_polygons (osm_id, osm_type, kind, name, geom)
      VALUES (1, 'w', 'park', 'Bospark',
        ST_Multi(ST_Buffer(
          ST_SetSRID(ST_MakePoint(${PARK[0]}, ${PARK[1]}), 4326)::geography, 600
        )::geometry))
    `.execute(pg.db);

    // A town sitting just inside the park (to prove containment beats nearest).
    await seedPlace(pg, 10, "town", "Parktown", 5.001, LAT);
    // A town with a near-by village (to prove a town wins over a closer village).
    await seedPlace(pg, 11, "town", "Townsville", 5.2, LAT);
    await seedPlace(pg, 12, "village", "Villyton", 5.205, LAT);
    // A lone village with no town within 8 km.
    await seedPlace(pg, 13, "village", "Hamville", 5.5, LAT);
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("names a tour by the named park it sits inside (beats a nearer town)", async () => {
    expect(await repo.resolvePlaceLabel(PARK[0], PARK[1])).toBe("Bospark");
  });

  it("prefers a town over a closer village", async () => {
    // At Townsville; Villyton is ~340 m away but a town outranks it.
    expect(await repo.resolvePlaceLabel(5.2, LAT)).toBe("Townsville");
  });

  it("falls back to the nearest village when no town is within range", async () => {
    // ~13.7 km from Townsville (beyond the 8 km town cap); Hamville is here.
    expect(await repo.resolvePlaceLabel(5.5, LAT)).toBe("Hamville");
  });

  it("returns null when nothing is within range and not inside a named area", async () => {
    expect(await repo.resolvePlaceLabel(6.0, LAT)).toBeNull();
  });
});
