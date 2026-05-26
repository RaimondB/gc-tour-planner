// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
  private readonly maxParallel: number;

  constructor(
    private readonly repo: OsmRepository,
    @Inject(OVERPASS_CLIENT) private readonly overpass: OverpassClient,
    @Inject(ConfigService) config: ConfigService,
  ) {
    const raw = config.get<string>("OVERPASS_MAX_PARALLEL");
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    this.maxParallel = Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
  }

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
      await this.refreshCellsBounded(staleCells);
    }

    const features = await this.repo.findFeatures(bbox, query.kinds);
    return { type: "FeatureCollection", features };
  }

  /**
   * Refresh every stale cell that intersects `bbox`. Public entry point for
   * the upload-triggered `overpass-refresh` job — it computes the bbox
   * around new caches' convex hull and asks for a warm-up. Skipped cells
   * (already fresh) cost a single staleness query and nothing else.
   *
   * Reuses the same per-cell in-flight dedup as listLanduse, so a user
   * navigating to the area while the job runs won't double-fetch.
   */
  async refreshBbox(bbox: Geo.BoundingBox): Promise<{
    cellsRefreshed: number;
    cellsAlreadyFresh: number;
  }> {
    const cells = cellsCovering(bbox);
    const stale = await this.repo.stalenessCheck(cells);
    const staleCells = cells.filter((c) => stale.includes(c.areaHash));
    if (staleCells.length > 0) {
      await this.refreshCellsBounded(staleCells);
    }
    return {
      cellsRefreshed: staleCells.length,
      cellsAlreadyFresh: cells.length - staleCells.length,
    };
  }

  /**
   * Public Overpass mirrors enforce a per-IP concurrent slot quota
   * (typically 2). Firing all stale cells with Promise.all trips that
   * cap and the LB silently drops new connects → undici raises
   * ETIMEDOUT mid-batch and the whole job fails. Cap to `maxParallel`
   * (default 2) workers consuming the queue. Per-cell in-flight dedup
   * still applies inside refreshCell.
   */
  private async refreshCellsBounded(cells: Cell[]): Promise<void> {
    const queue = cells.slice();
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) return;
        await this.refreshCell(next);
      }
    };
    const workerCount = Math.min(this.maxParallel, cells.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
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
