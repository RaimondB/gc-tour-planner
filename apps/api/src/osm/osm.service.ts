// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Injectable, Logger } from "@nestjs/common";
import type { Landuse } from "@gctp/shared";
import { LanduseRepository } from "./landuse.repository.js";

/**
 * Cap how much area a single request can ask for, to prevent both client
 * mistakes and abuse. 0.5° square ≈ 55 km × 35 km at lat 52° — comfortably
 * larger than any practical search radius (max 50 km, so bbox ~1° on
 * diagonal but still under the cap when checked per axis).
 */
const MAX_DELTA_DEG = 0.6;

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
