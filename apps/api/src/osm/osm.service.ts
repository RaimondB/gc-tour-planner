// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Geo, Landuse } from "@gctp/shared";
import { cellsCovering, type Cell } from "./cells.js";
import { OsmRepository } from "./osm.repository.js";
import { OVERPASS_CLIENT, type OverpassClient } from "./overpass.client.js";

/**
 * Cap how much area a single request can ask for, to prevent both client
 * mistakes and abuse. 0.5° square ≈ 55 km × 35 km at lat 52° — comfortably
 * larger than any practical search radius (max 50 km, so bbox ~1° on
 * diagonal but still under the cap when checked per axis).
 */
const MAX_DELTA_DEG = 0.6;

@Injectable()
export class OsmService {
  private readonly logger = new Logger(OsmService.name);
  private inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly repo: OsmRepository,
    @Inject(OVERPASS_CLIENT) private readonly overpass: OverpassClient,
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

    const cells = cellsCovering(bbox);
    const stale = await this.repo.stalenessCheck(cells);
    if (stale.length > 0) {
      const staleCells = cells.filter((c) => stale.includes(c.areaHash));
      await Promise.all(staleCells.map((c) => this.refreshCell(c)));
    }

    const features = await this.repo.findFeatures(bbox, query.kinds);
    return { type: "FeatureCollection", features };
  }

  /**
   * Synchronous refresh on miss/stale. Process-local in-flight map dedupes
   * concurrent requests for the same cell within this Node process. The
   * cross-process Valkey lock arrives with the BullMQ worker in M4.
   */
  private async refreshCell(cell: Cell): Promise<void> {
    const existing = this.inFlight.get(cell.areaHash);
    if (existing) return existing;

    const work = (async () => {
      this.logger.log(`Refreshing landuse cell ${cell.areaHash}`);
      const fetched = await this.overpass.fetchLanduse({
        minLng: cell.minLng,
        minLat: cell.minLat,
        maxLng: cell.maxLng,
        maxLat: cell.maxLat,
      } satisfies Geo.BoundingBox);
      await this.repo.replaceCell(cell.areaHash, fetched);
      this.logger.log(
        `Cell ${cell.areaHash}: stored ${fetched.length} landuse polygons`,
      );
    })().finally(() => {
      this.inFlight.delete(cell.areaHash);
    });
    this.inFlight.set(cell.areaHash, work);
    return work;
  }
}
