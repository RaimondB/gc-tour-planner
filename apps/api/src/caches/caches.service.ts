// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Injectable, NotFoundException } from "@nestjs/common";
import { Caches } from "@gctp/shared";
import { CachesRepository } from "./caches.repository.js";

@Injectable()
export class CachesService {
  constructor(private readonly repo: CachesRepository) {}

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
}
