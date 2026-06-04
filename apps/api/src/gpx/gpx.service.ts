// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { InjectQueue } from "@nestjs/bullmq";
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { parseGpx, type ParsedGpx, type UploadStats } from "@gctp/shared/gpx";
import type { Queue } from "bullmq";
import type { WalkingPrecomputeJobData } from "../jobs/walking-precompute/walking-precompute.types.js";
import { QUEUE_WALKING_PRECOMPUTE } from "../queues/queue.tokens.js";
import { GpxRepository } from "./gpx.repository.js";
import { GpxStorageService } from "./gpx-storage.service.js";

export interface GpxUploadResult {
  uploadId: string;
  cachesUpserted: number;
  waypointsInserted: number;
  findsRecorded: number;
  warnings: string[];
  /**
   * FR-I11 — per-upload summary. Drives the dropzone's "what just
   * happened" block (per-type counts, disabled/archived breakdown,
   * new vs updated vs stale).
   */
  stats: UploadStats;
  /**
   * True when the upload was auto-detected as a Groundspeak "My Finds"
   * Pocket Query (top-level `<gpx><name>`), which triggers the automatic
   * mark-as-found. The dropzone surfaces this so the detection is visible.
   */
  myFinds: boolean;
}

export interface IngestOptions {
  /**
   * Force every cache in the upload to be marked as found by the uploader
   * (idempotent — existing finds aren't disturbed), regardless of the file
   * contents. A Groundspeak "My Finds" Pocket Query is auto-detected and
   * always marked found whether or not this is set; this flag is the manual
   * override for marking a *regular* PQ as found.
   */
  markAsFound?: boolean;
}

@Injectable()
export class GpxService {
  private readonly logger = new Logger(GpxService.name);

  constructor(
    private readonly repo: GpxRepository,
    private readonly storage: GpxStorageService,
    @InjectQueue(QUEUE_WALKING_PRECOMPUTE)
    private readonly walkingQueue: Queue<WalkingPrecomputeJobData>,
  ) {}

  async ingest(
    ownerId: string,
    filename: string,
    xml: string,
    opts: IngestOptions = {},
  ): Promise<GpxUploadResult> {
    // Insert the upload row first so we have a stable id to name the
    // raw file with. The status is `received` until parse + upsert
    // complete; if anything below throws, the row is left in
    // `received` (and re-runnable via reprocess once the raw is on
    // disk). Errors before `markRawStored` leave no on-disk artifact.
    const uploadId = await this.repo.insertReceivedUpload(ownerId, filename);

    // Persist the raw XML before parsing. This is the whole point of
    // the feature — preserve the original so a future schema bump can
    // reparse without asking the user to re-upload. On filesystem
    // failure we propagate the error (the upload row will linger in
    // `received`; operator can re-upload).
    const { sizeBytes, sha256 } = await this.storage.save(uploadId, xml);
    await this.repo.markRawStored(uploadId, sizeBytes, sha256);

    return this.parseAndUpsert(ownerId, uploadId, xml, opts);
  }

  /**
   * Re-parse an already-stored raw upload + re-upsert. Used after the
   * parser learns about a new field (e.g. `disabled`) — the operator
   * can replay the old uploads to backfill without users having to
   * re-upload. The cache upsert path is identical to ingest, so any
   * fields added to `ParsedCache` flow through here automatically.
   *
   * Returns the same shape as `ingest`. The owner check is enforced
   * in the repository — admin can only reprocess their own uploads.
   * (When real multi-user auth lands in M6, this stays per-owner;
   * cross-tenant reprocess would need a separate superuser path.)
   */
  async reprocess(
    ownerId: string,
    uploadId: string,
    opts: IngestOptions = {},
  ): Promise<GpxUploadResult> {
    const meta = await this.repo.findUploadByOwner(uploadId, ownerId);
    if (!meta) {
      // Same response for "not yours" and "doesn't exist" so a cross-
      // tenant id probe can't tell them apart.
      throw new NotFoundException(`Upload ${uploadId} not found`);
    }
    if (meta.rawSizeBytes === null) {
      throw new BadRequestException(
        `Upload ${uploadId} has no raw bytes stored — predates the raw-storage feature.`,
      );
    }
    let xml: string;
    try {
      xml = await this.storage.read(uploadId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new NotFoundException(
        `Raw file for upload ${uploadId} missing on disk: ${message}`,
      );
    }
    return this.parseAndUpsert(ownerId, uploadId, xml, opts);
  }

  /**
   * Shared parse + upsert + status-transition path. Both `ingest` and
   * `reprocess` end here once the raw bytes are in hand.
   */
  private async parseAndUpsert(
    ownerId: string,
    uploadId: string,
    xml: string,
    opts: IngestOptions,
  ): Promise<GpxUploadResult> {
    let parsed: ParsedGpx;
    try {
      parsed = parseGpx(xml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.markFailed(uploadId, message);
      throw new BadRequestException(`Failed to parse GPX: ${message}`);
    }

    const exportedAtDate =
      parsed.exportedAt !== null ? new Date(parsed.exportedAt) : null;
    const { insertedOrUpdated, waypointsInserted, cacheIdByCode, outcome } =
      await this.repo.upsertFromGpx(
        ownerId,
        parsed.caches,
        parsed.waypoints,
        exportedAtDate,
      );

    // Auto-detected "My Finds" PQ marks finds without the user asking;
    // `opts.markAsFound` is the manual override for a regular PQ.
    const shouldMarkFound = parsed.isMyFinds || opts.markAsFound === true;
    let findsRecorded = 0;
    if (shouldMarkFound && cacheIdByCode.size > 0) {
      findsRecorded = await this.repo.recordFinds(
        ownerId,
        Array.from(cacheIdByCode.values()),
        "gpx-finds-import",
      );
    }

    await this.repo.markParsed(uploadId, insertedOrUpdated, exportedAtDate);
    const stats = buildUploadStats(parsed, outcome);

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
      stats,
      myFinds: parsed.isMyFinds,
    };
  }

  /**
   * Enqueue walking-graph precompute for the newly-arrived caches.
   * Landuse is no longer per-upload — it lives in `landuse_polygons` for
   * the entire imported region (ADR-0009). Caches that fall inside the
   * region pick up landuse memberships via the lazy `cache_landuse`
   * populate function on first plan.
   */
  /**
   * Optimization for the precompute fan-out: only enqueue *new* caches
   * — re-uploaded caches' walking neighbours haven't changed (their
   * coordinates would be the same). Stale caches are by definition
   * already in the cache.
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

/**
 * Roll the parser output + the per-row upsert outcome into the FR-I11
 * `UploadStats` shape. Pure function over the in-memory data — no DB
 * round-trips — so it's cheap enough to call on every upload.
 */
function buildUploadStats(
  parsed: ParsedGpx,
  outcome: ReadonlyMap<string, "new" | "updated" | "stale">,
): UploadStats {
  const byType: Record<string, number> = {};
  let disabled = 0;
  let archived = 0;
  for (const c of parsed.caches) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    // disabled / archived are orthogonal in the parser (see parse.ts:
    // archived caches don't double-count as disabled), so summing
    // each independently doesn't double-count rows.
    if (c.disabled) disabled += 1;
    if (c.archived) archived += 1;
  }
  let nu = 0;
  let upd = 0;
  let stale = 0;
  for (const o of outcome.values()) {
    if (o === "new") nu += 1;
    else if (o === "updated") upd += 1;
    else stale += 1;
  }
  return {
    total: parsed.caches.length,
    byType,
    disabled,
    archived,
    new: nu,
    updated: upd,
    stale,
    exportedAt: parsed.exportedAt,
  };
}
