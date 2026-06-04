// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Routing } from "@gctp/shared";
import { type CoordRow, RoutingRepository } from "./routing.repository.js";
import { OSRM_CLIENT, type OsrmClient } from "./osrm.client.js";
import { OsrmVersionService } from "./osrm-version.service.js";

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly repo: RoutingRepository,
    @Inject(OSRM_CLIENT) private readonly osrm: OsrmClient,
    private readonly osrmVersion: OsrmVersionService,
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

    const version = this.osrmVersion.getVersion();
    const cached = await this.repo.findLegs(
      [{ fromCacheId, toCacheId }],
      profile,
      version,
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
    await this.repo.upsertLegs(
      [
        {
          fromCacheId,
          toCacheId,
          profile,
          meters,
          seconds,
          geometry: leg.geometry,
        },
      ],
      version,
    );
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
   * Resolve the full OD matrix for the supplied cache IDs.
   *
   * Cache-aware: reads cached cells from `route_legs` (for the live OSRM
   * extract version), fills the gaps from OSRM `/table`, persists the new
   * cells so subsequent replans hit the cache, and returns the merged
   * matrix. Pass 2's TSP gets one DB query on the steady-state path.
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
    const version = this.osrmVersion.getVersion();

    // 1. Read whatever the DB already has for every off-diagonal pair.
    const pairs: { fromCacheId: number; toCacheId: number }[] = [];
    for (const from of ids) {
      for (const to of ids) {
        if (from !== to) pairs.push({ fromCacheId: from, toCacheId: to });
      }
    }
    const cachedRows = await this.repo.findMatrixCells(pairs, profile, version);
    const cellKey = (from: number, to: number) => `${from}:${to}`;
    const cellMap = new Map<string, { meters: number; seconds: number }>();
    // Pairs OSRM already declined to route on this extract. Stops the
    // matrix from re-asking OSRM the same questions every plan; see the
    // 1779640000000_route_legs_noroute migration. `getMatrix` is allowed
    // to omit these cells from the returned matrix — callers already
    // treat missing cells as +Infinity in TSP.
    const noRouteSet = new Set<string>();
    for (const r of cachedRows) {
      const k = cellKey(r.fromCacheId, r.toCacheId);
      if (r.noroute) noRouteSet.add(k);
      else cellMap.set(k, { meters: r.meters, seconds: r.seconds });
    }

    // 2. Identify rows that are entirely cached vs need an OSRM /table call.
    //    `osrm.table([origin, ...dests])` returns row 0 for the origin's
    //    distances to every destination — same shape Pass 1's walking-graph
    //    builder uses. One call per origin with missing cells keeps the
    //    request size well below the 5000-coord --max-table-size cap.
    const toPersist: Array<{
      fromCacheId: number;
      toCacheId: number;
      profile: Routing.RoutingProfile;
      meters: number;
      seconds: number;
    }> = [];

    const toPersistNoRoute: Array<{
      fromCacheId: number;
      toCacheId: number;
      profile: Routing.RoutingProfile;
    }> = [];

    let osrmCalls = 0;
    for (const from of ids) {
      const missing = ids.filter(
        (to) =>
          to !== from &&
          !cellMap.has(cellKey(from, to)) &&
          !noRouteSet.has(cellKey(from, to)),
      );
      if (missing.length === 0) continue;
      osrmCalls += 1;
      const fromC = coords.get(from)!;
      const dests = missing.map<[number, number]>((to) => {
        const c = coords.get(to)!;
        return [c.lng, c.lat];
      });
      const matrix = await this.osrm.table(
        [[fromC.lng, fromC.lat], ...dests],
        profile,
      );
      const row0 = matrix[0];
      if (!row0) continue;
      for (let j = 0; j < missing.length; j += 1) {
        const cell = row0[j + 1]; // skip diagonal (origin → origin)
        const to = missing[j]!;
        if (!cell) {
          noRouteSet.add(cellKey(from, to));
          toPersistNoRoute.push({
            fromCacheId: from,
            toCacheId: to,
            profile,
          });
          continue;
        }
        const meters = round2(cell.meters);
        const seconds = round2(cell.seconds);
        cellMap.set(cellKey(from, to), { meters, seconds });
        toPersist.push({
          fromCacheId: from,
          toCacheId: to,
          profile,
          meters,
          seconds,
        });
      }
    }

    if (toPersist.length > 0) {
      this.logger.debug(
        `getMatrix: ${osrmCalls} OSRM /table calls; persisting ${toPersist.length} new cells`,
      );
      await this.repo.upsertMatrixCells(toPersist, version);
    } else if (osrmCalls === 0) {
      this.logger.debug(
        `getMatrix: full cache hit on ${ids.length}×${ids.length - 1} matrix`,
      );
    }
    if (toPersistNoRoute.length > 0) {
      await this.repo.upsertNorouteCells(toPersistNoRoute, version);
    }

    // 3. Assemble the matrix in the caller's order. A `null` cell happens
    //    when OSRM couldn't route the pair (disconnected sub-graph).
    const idx = new Map<number, number>();
    ids.forEach((id, i) => idx.set(id, i));
    const legs: (Routing.MatrixEntry | null)[][] = ids.map((from) =>
      ids.map((to) => {
        if (from === to) return { meters: 0, seconds: 0 };
        return cellMap.get(cellKey(from, to)) ?? null;
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
