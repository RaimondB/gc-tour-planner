// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Injectable, Logger } from "@nestjs/common";
import type { Landuse, ParkingFacilities } from "@gctp/shared";
import { LanduseRepository } from "./landuse.repository.js";
import { ParkingFacilitiesRepository } from "./parking-facilities.repository.js";

/**
 * Cap how much area a single request can ask for, as a guard against
 * deliberately huge ad-hoc requests. With server-side LOD in
 * `LanduseRepository.findFeatures` (ADR-0009 follow-up), the bbox query
 * is cheap and even a 2°-wide response is well under 10 MB of geojson.
 *
 * The UI's max 50 km search radius → padded 60 km → at lat 52° produces
 * a **longitude** extent of ~1.75° (cos(52°) ≈ 0.62 makes lng degrees
 * smaller than lat degrees). 2.5° per axis gives comfortable headroom
 * for that worst case plus the higher-latitude edges of typical mapping
 * regions; only deliberately abusive curls would trip it.
 */
const MAX_DELTA_DEG = 2.5;

/**
 * Read-only service over the osm2pgsql-fed `landuse_polygons` table
 * (ADR-0009). Replaces the Overpass-based OsmService — no more cell
 * staleness, no more refresh fan-out. The HTTP /landuse endpoint and
 * Pass-1 cluster scoring consume `findFeatures` directly.
 */
@Injectable()
export class OsmService {
  private readonly logger = new Logger(OsmService.name);

  constructor(
    private readonly repo: LanduseRepository,
    private readonly parkingRepo: ParkingFacilitiesRepository,
  ) {}

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

  async listParkingFacilities(
    query: ParkingFacilities.ParkingFacilitiesQuery,
  ): Promise<ParkingFacilities.ParkingFacilitiesResponse> {
    const { bbox, access, fee } = query;
    if (
      bbox.maxLng - bbox.minLng > MAX_DELTA_DEG ||
      bbox.maxLat - bbox.minLat > MAX_DELTA_DEG
    ) {
      throw new Error(
        `Parking-facilities bbox too large (max ${MAX_DELTA_DEG}° per axis). Pan in to refine.`,
      );
    }
    const features = await this.parkingRepo.findFeatures(bbox, {
      access,
      fee,
    });
    return { type: "FeatureCollection", features };
  }
}
