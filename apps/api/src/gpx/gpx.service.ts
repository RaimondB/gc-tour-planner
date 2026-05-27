// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { InjectQueue } from "@nestjs/bullmq";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { parseGpx, type ParsedGpx } from "@gctp/shared/gpx";
import type { Queue } from "bullmq";
import type { WalkingPrecomputeJobData } from "../jobs/walking-precompute/walking-precompute.types.js";
import { QUEUE_WALKING_PRECOMPUTE } from "../queues/queue.tokens.js";
import { GpxRepository } from "./gpx.repository.js";

export interface GpxUploadResult {
  uploadId: string;
  cachesUpserted: number;
  waypointsInserted: number;
  findsRecorded: number;
  warnings: string[];
}

export interface IngestOptions {
  /**
   * When true, every cache in the upload is also marked as found by the
   * uploader (idempotent — existing finds aren't disturbed). Intended for
   * Groundspeak "My Finds" Pocket Queries.
   */
  markAsFound?: boolean;
}

@Injectable()
export class GpxService {
  private readonly logger = new Logger(GpxService.name);

  constructor(
    private readonly repo: GpxRepository,
    @InjectQueue(QUEUE_WALKING_PRECOMPUTE)
    private readonly walkingQueue: Queue<WalkingPrecomputeJobData>,
  ) {}

  async ingest(
    ownerId: string,
    filename: string,
    xml: string,
    opts: IngestOptions = {},
  ): Promise<GpxUploadResult> {
    let parsed: ParsedGpx;
    try {
      parsed = parseGpx(xml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.recordUpload(ownerId, filename, 0, "failed", message);
      throw new BadRequestException(`Failed to parse GPX: ${message}`);
    }

    const { insertedOrUpdated, waypointsInserted, cacheIdByCode } =
      await this.repo.upsertFromGpx(ownerId, parsed.caches, parsed.waypoints);

    let findsRecorded = 0;
    if (opts.markAsFound && cacheIdByCode.size > 0) {
      findsRecorded = await this.repo.recordFinds(
        ownerId,
        Array.from(cacheIdByCode.values()),
        "gpx-finds-import",
      );
    }

    const uploadId = await this.repo.recordUpload(
      ownerId,
      filename,
      insertedOrUpdated,
      "parsed",
      null,
    );

    // Fire-and-forget enqueue. The job IDs are not surfaced to the upload
    // response because the user shouldn't wait for them — the bull-board
    // dashboard is the operator's view, and `/admin/jobs` summary tile
    // shows aggregate progress. We log enqueue failures (e.g. Valkey down)
    // but don't fail the upload: the caches are saved, the precompute can
    // be re-triggered manually from /admin/jobs.
    if (cacheIdByCode.size > 0) {
      const newCacheIds = Array.from(cacheIdByCode.values());
      void this.enqueuePrecompute(ownerId, newCacheIds);
    }

    return {
      uploadId,
      cachesUpserted: insertedOrUpdated,
      waypointsInserted,
      findsRecorded,
      warnings: parsed.warnings,
    };
  }

  /**
   * Enqueue walking-graph precompute for the newly-arrived caches.
   * Landuse is no longer per-upload — it lives in `landuse_polygons` for
   * the entire imported region (ADR-0009). Caches that fall inside the
   * region pick up landuse memberships via the lazy `cache_landuse`
   * populate function on first plan.
   */
  private async enqueuePrecompute(
    ownerId: string,
    newCacheIds: number[],
  ): Promise<void> {
    try {
      await this.walkingQueue.add("precompute", {
        ownerId,
        newCacheIds,
        reason: "upload",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `walking precompute enqueue failed for owner=${ownerId} (${newCacheIds.length} caches): ${message}. ` +
          `Caches are saved; retry from /admin/jobs.`,
      );
    }
  }
}
