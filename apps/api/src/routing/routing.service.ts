// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Routing } from "@gctp/shared";
import {
  type CoordRow,
  type FoundLeg,
  type PersistLegInput,
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
   * Resolve the full OD matrix for the supplied cache IDs. Cached pairs
   * (in either direction) come straight from `route_legs`; missing pairs
   * trigger one `osrm /table` call for the full set, after which every new
   * pair is persisted via `route_legs`.
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

    // Collect every pair (ordered) we'll need.
    const allPairs: { fromCacheId: number; toCacheId: number }[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = 0; j < ids.length; j += 1) {
        if (i === j) continue;
        allPairs.push({ fromCacheId: ids[i]!, toCacheId: ids[j]! });
      }
    }

    const cachedLegs = await this.repo.findLegs(allPairs, profile);
    const cachedKey = (a: number, b: number) => `${a}:${b}`;
    const cachedMap = new Map<string, FoundLeg>();
    for (const l of cachedLegs) {
      cachedMap.set(cachedKey(l.fromCacheId, l.toCacheId), l);
    }

    const missingPairs = allPairs.filter(
      (p) => !cachedMap.has(cachedKey(p.fromCacheId, p.toCacheId)),
    );

    // Hit OSRM once for the entire matrix if anything's missing — /table is
    // far cheaper than N(N-1) /route calls. This also re-fetches some pairs
    // we already have, which is fine; upsert is idempotent.
    let osrmTable:
      | (import("./osrm.client.js").OsrmMatrixEntry | null)[][]
      | null = null;
    if (missingPairs.length > 0) {
      const coordList = ids.map<[number, number]>((id) => {
        const c = coords.get(id)!;
        return [c.lng, c.lat];
      });
      osrmTable = await this.osrm.table(coordList, profile);

      // Persist newly-known legs. We do NOT persist legs whose geometry we
      // don't have (osrm /table doesn't return geometry). The matrix-only
      // legs live in osrmTable but aren't written to route_legs — they only
      // come back as Matrix entries. getLeg() can fill geometry on demand
      // when M5 actually picks a tour.
      const persistedFromOsrmTable: PersistLegInput[] = [];
      // (intentionally empty — /table has no geometry; this list stays for
      // future use if we move to per-pair /route)
      await this.repo.upsertLegs(persistedFromOsrmTable);
    }

    const legs: (Routing.MatrixEntry | null)[][] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const row: (Routing.MatrixEntry | null)[] = [];
      for (let j = 0; j < ids.length; j += 1) {
        if (i === j) {
          row.push({ meters: 0, seconds: 0 });
          continue;
        }
        const fromId = ids[i]!;
        const toId = ids[j]!;
        const cached = cachedMap.get(cachedKey(fromId, toId));
        if (cached) {
          row.push({ meters: cached.meters, seconds: cached.seconds });
          continue;
        }
        const osrmEntry = osrmTable?.[i]?.[j] ?? null;
        row.push(osrmEntry);
      }
      legs.push(row);
    }

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
