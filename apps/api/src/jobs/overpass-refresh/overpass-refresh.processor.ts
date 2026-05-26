// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Job } from "bullmq";
import { OsmService } from "../../osm/osm.service.js";
import { PrecomputeStateRepository } from "../../precompute-state/precompute-state.repository.js";
import { QUEUE_OVERPASS_REFRESH } from "../../queues/queue.tokens.js";
import { CacheBboxRepository } from "./cache-bbox.repository.js";
import type {
  OverpassRefreshJobData,
  OverpassRefreshJobResult,
} from "./overpass-refresh.types.js";

/**
 * Background warm of `osm_landuse` for the area around newly-uploaded
 * caches. Computes the convex-hull bbox + 500 m buffer and reuses the
 * existing OsmService.refreshBbox dedup / staleness path. Cells fresher
 * than the existing 30-day TTL (`STALENESS_MS` in cells.ts) are skipped —
 * the per-job-window TTL knob `OVERPASS_REFRESH_TTL_HOURS` is currently
 * surfaced in docs as a documented future tightening but the live floor
 * is the 30-day cell TTL.
 *
 * See docs/design/precompute.md; ADR-0007 for the why.
 */
@Processor(QUEUE_OVERPASS_REFRESH)
export class OverpassRefreshProcessor extends WorkerHost {
  private readonly logger = new Logger(OverpassRefreshProcessor.name);

  constructor(
    private readonly bbox: CacheBboxRepository,
    private readonly osm: OsmService,
    private readonly state: PrecomputeStateRepository,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(
    job: Job<OverpassRefreshJobData, OverpassRefreshJobResult>,
  ): Promise<OverpassRefreshJobResult> {
    const startedAt = Date.now();
    const { ownerId, newCacheIds, reason } = job.data;

    if (newCacheIds.length === 0) {
      return {
        inScopeCount: 0,
        cellsRefreshed: 0,
        cellsAlreadyFresh: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const bufferM = this.envInt("OVERPASS_BBOX_BUFFER_M", 500);
    this.logger.log(
      `overpass-refresh (${reason}): owner=${ownerId} caches=${newCacheIds.length}`,
    );

    await this.state.markBulk(newCacheIds, "landuse", "in_progress");

    try {
      const bbox = await this.bbox.bboxAround(
        ownerId,
        newCacheIds,
        bufferM,
      );
      if (!bbox) {
        // No matching caches (e.g. they were deleted between upload and
        // job pick-up). Mark fresh — there's nothing to compute.
        await this.state.markBulk(newCacheIds, "landuse", "fresh");
        return {
          inScopeCount: newCacheIds.length,
          cellsRefreshed: 0,
          cellsAlreadyFresh: 0,
          durationMs: Date.now() - startedAt,
        };
      }

      const refresh = await this.osm.refreshBbox(bbox);

      await this.state.markBulk(newCacheIds, "landuse", "fresh");

      const result: OverpassRefreshJobResult = {
        inScopeCount: newCacheIds.length,
        cellsRefreshed: refresh.cellsRefreshed,
        cellsAlreadyFresh: refresh.cellsAlreadyFresh,
        durationMs: Date.now() - startedAt,
      };
      this.logger.log(
        `overpass-refresh (${reason}): done caches=${result.inScopeCount} ` +
          `cellsRefreshed=${result.cellsRefreshed} ` +
          `cellsAlreadyFresh=${result.cellsAlreadyFresh} ` +
          `${result.durationMs}ms`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `overpass-refresh failed for owner=${ownerId}: ${message}`,
      );
      await this.state.markBulk(newCacheIds, "landuse", "failed", {
        errorText: message.slice(0, 500),
      });
      throw err;
    }
  }

  private envInt(name: string, fallback: number): number {
    const raw = this.config.get<string>(name);
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
}
