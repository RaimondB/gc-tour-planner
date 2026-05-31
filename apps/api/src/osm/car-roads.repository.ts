// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

/** A car-accessible road's nearest pull-over point to a query location. */
export interface RoadSnapCandidate {
  /** ST_ClosestPoint of the road to the query point, [lng, lat]. */
  point: [number, number];
  highway: string;
  name: string | null;
  /** Geography distance (m) from the query point to the road. */
  distM: number;
}

/** Eligible road classes — must mirror CAR_ROAD_CLASSES in
 *  infra/osm2pgsql/osm-features.lua (the coarse Lua filter). Enforced here
 *  too so a test-seeded DB can't smuggle in other classes. */
const ELIGIBLE_HIGHWAY = [
  "residential",
  "living_street",
  "unclassified",
  "service",
  "tertiary",
] as const;

/** Roads at or above this km/h are dropped as "no stopping" even if the
 *  class looks minor (mis-tagged). NULL maxspeed passes — see ADR-0012. */
const MAX_SPEED_KMH = 70;

/**
 * Read-side repository for `car_roads` (ADR-0012).
 *
 * Writes happen out-of-band via osm2pgsql in the same pass that populates
 * `landuse_polygons` + `parking_facilities` — no write API here.
 */
@Injectable()
export class CarRoadsRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Planner-side helper for the `osrm-nearest-road` start mode: the `limit`
   * eligible roads closest to the **tour path** (not just its centroid),
   * within `radiusM`, each reduced to its closest point to the path (the
   * "pull-over" spot). Ranking by the whole loop — rather than the centroid —
   * is what lets a road that hugs a leg out near the cluster's edge beat one
   * sitting near the middle but off-route; the caller then routes OSRM `foot`
   * from each and scores them with the loop-aware selector.
   *
   * `tourPath` is the ordered cycle of cache coordinates (the caller closes
   * it by repeating the first point). The coarse class filter is already
   * applied by the Lua import; the FINE filter (access / motor_vehicle /
   * maxspeed / service=driveway) lives here so it can be retuned without a
   * re-import (ADR-0012). Returns at most `limit` candidates, deduped to ~1 m,
   * nearest first.
   */
  async findNearestRoadPoints(
    tourPath: readonly [number, number][],
    radiusM: number,
    opts: { limit: number },
  ): Promise<RoadSnapCandidate[]> {
    if (tourPath.length === 0) return [];
    // Build the reference geometry the candidates are measured against: a
    // LineString along the tour when we have ≥2 points, else a single point.
    const wkt =
      tourPath.length >= 2
        ? `LINESTRING(${tourPath.map(([x, y]) => `${x} ${y}`).join(", ")})`
        : `POINT(${tourPath[0]![0]} ${tourPath[0]![1]})`;
    const ref = sql`ST_GeomFromText(${wkt}, 4326)`;

    const q = this.db
      .selectFrom("car_roads")
      .select([
        "highway",
        "name",
        sql<number>`ST_X(ST_ClosestPoint(geom, ${ref}))`.as("px"),
        sql<number>`ST_Y(ST_ClosestPoint(geom, ${ref}))`.as("py"),
        sql<number>`ST_Distance(geom::geography, ${ref}::geography)`.as("dist_m"),
      ])
      // Indexable bbox prefilter (meters → degrees, ~111 km / degree).
      .where(sql<boolean>`geom && ST_Expand(${ref}, ${radiusM / 111_000})`)
      // Precise distance to the path on the much smaller envelope result set.
      .where(
        sql<boolean>`ST_Distance(geom::geography, ${ref}::geography) <= ${radiusM}`,
      )
      // Coarse class guard (belt-and-braces vs the Lua filter).
      .where("highway", "in", ELIGIBLE_HIGHWAY as unknown as string[])
      // Fine filter — NULLs pass; only explicit no-go values are dropped.
      .where(sql<boolean>`access IS NULL OR access NOT IN ('no', 'private')`)
      .where(
        sql<boolean>`motor_vehicle IS NULL OR motor_vehicle NOT IN ('no', 'private')`,
      )
      .where(sql<boolean>`maxspeed_kmh IS NULL OR maxspeed_kmh < ${MAX_SPEED_KMH}`)
      .where(sql<boolean>`service IS NULL OR service <> 'driveway'`)
      // Index-assisted KNN order against the path; cheap distance filter above
      // keeps it bounded.
      .orderBy(sql`geom <-> ${ref}`)
      .limit(opts.limit);

    interface Row {
      highway: string;
      name: string | null;
      px: number;
      py: number;
      dist_m: number;
    }
    const rows = (await q.execute()) as unknown as Row[];

    // Dedup near-identical closest points (parallel/branching roads snap to
    // the same spot) so the OSRM /table the caller fires stays small.
    const seen = new Set<string>();
    const out: RoadSnapCandidate[] = [];
    for (const r of rows) {
      const px = Number(r.px);
      const py = Number(r.py);
      const key = `${px.toFixed(5)},${py.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        point: [px, py],
        highway: r.highway,
        name: r.name,
        distM: Number(r.dist_m),
      });
    }
    return out;
  }
}
