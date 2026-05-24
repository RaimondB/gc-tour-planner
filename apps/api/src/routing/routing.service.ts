// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Routing } from "@gctp/shared";
import {
  type CoordRow,
  RoutingRepository,
} from "./routing.repository.js";
import { OSRM_CLIENT, type OsrmClient } from "./osrm.client.js";

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly repo: RoutingRepository,
    @Inject(OSRM_CLIENT) private readonly osrm: OsrmClient,
  ) {}

  /**
   * Resolve one walking leg. Reads `route_legs` first; on miss, calls OSRM
   * `/route/v1/foot/...` and persists. Returns null when OSRM can't route
   * the pair (disconnected graph, point off-network).
   */
  async getLeg(
    ownerId: string,
    fromCacheId: number,
    toCacheId: number,
    profile: Routing.RoutingProfile,
  ): Promise<Routing.Leg | null> {
    // ALWAYS validate ownership before serving — route_legs is owner-agnostic
    // (the same walking route is the same regardless of who asked), so cache
    // hits would otherwise leak across users.
    const coords = await this.coordMapOrThrow(ownerId, [
      fromCacheId,
      toCacheId,
    ]);

    if (fromCacheId === toCacheId) {
      const c = coords.get(fromCacheId)!;
      return {
        fromCacheId,
        toCacheId,
        profile,
        meters: 0,
        seconds: 0,
        geometry: {
          type: "LineString",
          coordinates: [
            [c.lng, c.lat],
            [c.lng, c.lat],
          ],
        },
      };
    }

    const cached = await this.repo.findLegs(
      [{ fromCacheId, toCacheId }],
      profile,
    );
    if (cached.length > 0) return cached[0]!;

    const fromC = coords.get(fromCacheId)!;
    const toC = coords.get(toCacheId)!;

    const leg = await this.osrm.route(
      [fromC.lng, fromC.lat],
      [toC.lng, toC.lat],
      profile,
    );
    if (!leg) return null;

    // Round to the column precision (NUMERIC(12,2)) so the in-memory value
    // returned now matches what a subsequent cache-hit will return.
    const meters = round2(leg.meters);
    const seconds = round2(leg.seconds);
    await this.repo.upsertLegs([
      {
        fromCacheId,
        toCacheId,
        profile,
        meters,
        seconds,
        geometry: leg.geometry,
      },
    ]);
    return {
      fromCacheId,
      toCacheId,
      profile,
      meters,
      seconds,
      geometry: leg.geometry,
    };
  }

  /**
   * Resolve the full OD matrix for the supplied cache IDs in a single OSRM
   * `/table` call. The `route_legs` table is intentionally NOT consulted here:
   * `/table` is geometry-free, so matrix results were never persisted, so the
   * cache hit rate for this path is zero. Reading from `route_legs` was dead
   * work — and at N≈100 it built an N×(N-1)-clause SQL predicate large enough
   * to overflow Kysely's recursive query compiler. `getLeg` (per-pair,
   * geometry-bearing) still uses the cache.
   *
   * `legs[i][j]` is the leg from `cacheIds[i]` to `cacheIds[j]`; diagonals
   * are { meters: 0, seconds: 0 }. A `null` cell means OSRM couldn't route
   * the pair — caller decides how to penalize.
   */
  async getMatrix(
    ownerId: string,
    cacheIds: readonly number[],
    profile: Routing.RoutingProfile,
  ): Promise<Routing.Matrix> {
    const ids = Array.from(new Set(cacheIds));
    if (ids.length === 0) {
      return { profile, cacheIds: [], legs: [] };
    }
    const coords = await this.coordMapOrThrow(ownerId, ids);

    const coordList = ids.map<[number, number]>((id) => {
      const c = coords.get(id)!;
      return [c.lng, c.lat];
    });
    const osrmTable = await this.osrm.table(coordList, profile);

    const legs: (Routing.MatrixEntry | null)[][] = osrmTable.map((row, i) =>
      row.map((cell, j) => {
        if (i === j) return { meters: 0, seconds: 0 };
        return cell;
      }),
    );

    return { profile, cacheIds: ids, legs };
  }

  private async coordMapOrThrow(
    ownerId: string,
    cacheIds: readonly number[],
  ): Promise<Map<number, CoordRow>> {
    const rows = await this.repo.coordsFor(ownerId, cacheIds);
    const map = new Map<number, CoordRow>();
    for (const r of rows) map.set(r.id, r);
    const missing = cacheIds.filter((id) => !map.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(
        `Caches not found for this user: ${missing.join(", ")}`,
      );
    }
    return map;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
