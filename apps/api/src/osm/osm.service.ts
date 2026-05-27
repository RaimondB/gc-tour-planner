// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Injectable, Logger } from "@nestjs/common";
import type { Landuse } from "@gctp/shared";
import { LanduseRepository } from "./landuse.repository.js";

/**
 * Cap how much area a single request can ask for, to prevent runaway
 * payloads. With the osm2pgsql-fed table (ADR-0009), the GIST bbox query
 * itself is fast (<100 ms); the limit exists to bound JSON-serialization
 * cost — NL has ~32 landuse polygons / km², and a max-radius search
 * already returns tens of thousands of polygons per request.
 *
 * 1.2° per axis ≈ 130 km × 90 km at lat 52° — sized to comfortably cover
 * the UI's max search radius (50 km radius × 1.2 pad → bbox 1.08° per
 * axis). Smaller search radii are well inside the cap; only ad-hoc curl
 * with a deliberately huge bbox would trip it.
 */
const MAX_DELTA_DEG = 1.2;

/**
 * Read-only service over the osm2pgsql-fed `landuse_polygons` table
 * (ADR-0009). Replaces the Overpass-based OsmService — no more cell
 * staleness, no more refresh fan-out. The HTTP /landuse endpoint and
 * Pass-1 cluster scoring consume `findFeatures` directly.
 */
@Injectable()
export class OsmService {
  private readonly logger = new Logger(OsmService.name);

  constructor(private readonly repo: LanduseRepository) {}

  async listLanduse(
    query: Landuse.LanduseQuery,
  ): Promise<Landuse.LanduseResponse> {
    const { bbox } = query;
    if (
      bbox.maxLng - bbox.minLng > MAX_DELTA_DEG ||
      bbox.maxLat - bbox.minLat > MAX_DELTA_DEG
    ) {
      throw new Error(
        `Landuse bbox too large (max ${MAX_DELTA_DEG}° per axis). Pan in to refine.`,
      );
    }

    const features = await this.repo.findFeatures(bbox, query.kinds);
    return { type: "FeatureCollection", features };
  }
}
