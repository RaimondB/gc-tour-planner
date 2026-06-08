// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Caches } from "@gctp/shared";
import type { Queue } from "bullmq";
import type { WalkingPrecomputeJobData } from "../jobs/walking-precompute/walking-precompute.types.js";
import { QUEUE_WALKING_PRECOMPUTE } from "../queues/queue.tokens.js";
import { CachesRepository } from "./caches.repository.js";

@Injectable()
export class CachesService {
  private readonly logger = new Logger(CachesService.name);

  constructor(
    private readonly repo: CachesRepository,
    @InjectQueue(QUEUE_WALKING_PRECOMPUTE)
    private readonly walkingQueue: Queue<WalkingPrecomputeJobData>,
  ) {}

  async list(
    ownerId: string,
    q: Caches.CachesQuery,
  ): Promise<Caches.CachesResponse> {
    const caches = await this.repo.find({
      ownerId,
      center: q.center,
      radiusM: q.radiusM,
      types: q.types,
      attributeGroups: q.attributes,
      excludeFound: q.excludeFound,
      contexts: q.contexts,
      includeDisabled: q.includeDisabled,
      includeArchived: q.includeArchived,
      solvedMysteriesOnly: q.solvedMysteriesOnly,
      multiSubtype: q.multiSubtype,
      hideToolCaches: q.hideToolCaches,
    });

    // clustersHint is a coarse grid bucket count; the real cluster discovery
    // happens in the tour planner (M5). For now we just count caches per
    // 0.01-degree cell so the frontend can show density indicators cheaply.
    const buckets = new Map<string, number>();
    for (const c of caches) {
      const [lng, lat] = c.location.coordinates;
      const key = `${Math.round(lng * 100) / 100},${Math.round(lat * 100) / 100}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const clustersHint = Array.from(buckets, ([gridCell, count]) => ({
      gridCell,
      count,
    }));

    return { caches, clustersHint };
  }

  /**
   * Fetch a specific set of caches by id, owner-scoped. Used by the tour
   * planner — Pass 2 needs coords + parkingPoints for the cluster the user
   * picked from `/tours/clusters`.
   */
  async findByIds(
    ownerId: string,
    ids: readonly number[],
  ): Promise<Caches.CacheDTO[]> {
    return this.repo.findByIds(ownerId, ids);
  }

  /**
   * Full detail for a single cache (the popup-only fields the lean
   * `GET /caches` list omits). Owner-scoped via `findByIds`; 404 when the id
   * isn't the current user's (per-user GPX isolation — CLAUDE.md hard rule).
   */
  async getDetail(ownerId: string, id: number): Promise<Caches.CacheDTO> {
    const [cache] = await this.repo.findByIds(ownerId, [id]);
    if (!cache) {
      throw new NotFoundException(`Cache ${id} not found for this user`);
    }
    return cache;
  }

  async markFound(
    ownerId: string,
    cacheId: number,
  ): Promise<{ created: boolean }> {
    if (!(await this.repo.existsForOwner(ownerId, cacheId))) {
      throw new NotFoundException(`Cache ${cacheId} not found for this user`);
    }
    return { created: await this.repo.markFound(ownerId, cacheId) };
  }

  async unmarkFound(
    ownerId: string,
    cacheId: number,
  ): Promise<{ removed: boolean }> {
    if (!(await this.repo.existsForOwner(ownerId, cacheId))) {
      throw new NotFoundException(`Cache ${cacheId} not found for this user`);
    }
    return { removed: await this.repo.unmarkFound(ownerId, cacheId) };
  }

  /**
   * Remove a cache's solved coordinate, reverting its planning `location` to
   * the posted coord. The repository invalidates the cache's location-derived
   * precompute (route_legs + cache_landuse); we re-warm it here so the next
   * plan reads fresh walking distances. `cleared: false` means the cache had
   * no solved coordinate to remove (idempotent).
   */
  async clearSolved(
    ownerId: string,
    cacheId: number,
  ): Promise<{ cleared: boolean }> {
    if (!(await this.repo.existsForOwner(ownerId, cacheId))) {
      throw new NotFoundException(`Cache ${cacheId} not found for this user`);
    }
    const cleared = await this.repo.clearSolved(ownerId, cacheId);
    if (cleared) {
      try {
        await this.walkingQueue.add("precompute", {
          ownerId,
          newCacheIds: [cacheId],
          reason: "retrigger-one",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `walking precompute enqueue failed after clearing solved coords for ` +
            `cache=${cacheId}: ${message}. Stale legs were deleted; retry from /admin/jobs.`,
        );
      }
    }
    return { cleared };
  }
}
