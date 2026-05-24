// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Logger } from "@nestjs/common";
import type { Routing } from "@gctp/shared";
import type { CachesRepository } from "../../../caches/caches.repository.js";
import type { OsrmClient } from "../../../routing/osrm.client.js";
import type { RoutingRepository } from "../../../routing/routing.repository.js";

/**
 * One edge in the sparse walking graph.
 *
 * Edges are directional — OSRM does not guarantee `w(a,b) === w(b,a)` for
 * walking (think one-way stairs / footpath direction restrictions). The
 * builder symmetrises by emitting both directions when either side ranks the
 * other in its k-nearest; downstream community detection treats the graph as
 * undirected by taking max(w_ab, w_ba) per pair.
 */
export interface WalkingEdge {
  fromCacheId: number;
  toCacheId: number;
  meters: number;
  seconds: number;
}

export interface CoordinatedCache {
  id: number;
  lng: number;
  lat: number;
}

export interface BuildWalkingGraphInput {
  ownerId: string;
  caches: readonly CoordinatedCache[];
  /** Final k-nearest neighbours kept per origin (walking distance ranked). */
  kTarget: number;
  /** Haversine radius for the initial PostGIS k-NN over-fetch (metres). */
  radiusM: number;
  /**
   * HARD upper bound on edge walking distance. Pairs whose OSRM walking leg
   * exceeds this are dropped from the graph entirely. Without this guard a
   * river-crossing detour (200 m Haversine → 5 km on foot) sneaks into the
   * top-k and lets Louvain fuse cross-river clusters via the long edge.
   * Caller typically passes `PlanInput.maxLinkMeters` (default 1500).
   */
  maxEdgeMeters: number;
  profile: Routing.RoutingProfile;
}

/**
 * Build a sparse, symmetric walking graph for a candidate cache pool.
 *
 * Flow:
 *  1. **Over-fetch** Haversine k-NN candidates via PostGIS `<->` —
 *     `k_candidates = 3 × kTarget` per origin within `radiusM`.
 *  2. **Re-rank** by OSRM walking distance: read what we already have from
 *     `route_legs`, fetch the rest via OSRM `/table` (one call per origin,
 *     `[origin, ...candidates]`), keep the closest `kTarget` real-on-foot
 *     neighbours.
 *  3. **Persist** the newly fetched cells to `route_legs` with
 *     `source = 'table'` so subsequent plans hit the cache.
 *  4. **Symmetrise**: an edge `(a,b)` survives if either `b ∈ kNN(a)` OR
 *     `a ∈ kNN(b)`. Avoids one-sided dropouts at cluster boundaries.
 *
 * Returns the symmetric edge list. Callers feed it to community detection.
 *
 * Why over-fetch: Haversine alone selects neighbours across unwalkable
 * barriers (river, motorway). OSRM either returns a 4 km detour (we'd waste
 * a cell on a useless edge) or `null` (we'd miss the *actually* nearest
 * walkable neighbour, which was the 7th-closest as the crow flies but the
 * 1st on foot). Picking 3× and re-ranking on the walking metric fixes both.
 */
export async function buildWalkingGraph(
  input: BuildWalkingGraphInput,
  deps: {
    caches: CachesRepository;
    routing: RoutingRepository;
    osrm: OsrmClient;
  },
  // Concurrency cap for OSRM /table calls. OSRM single-instance fronted by
  // nginx tolerates ~20-50 inflight without notable QoS degradation.
  concurrency = 8,
): Promise<WalkingEdge[]> {
  const logger = new Logger(buildWalkingGraph.name);
  const { caches, kTarget, radiusM, maxEdgeMeters, profile, ownerId } = input;
  if (caches.length < 2 || kTarget <= 0) return [];

  const kCandidates = Math.max(kTarget * 3, kTarget + 5);
  const coordsById = new Map(
    caches.map((c) => [c.id, [c.lng, c.lat] as [number, number]]),
  );

  // 1. PostGIS over-fetch.
  const candidatePairs = await deps.caches.nearestNeighbors(
    ownerId,
    caches.map((c) => c.id),
    kCandidates,
    radiusM,
  );
  if (candidatePairs.length === 0) return [];

  // Group candidates per origin for the OSRM phase.
  const candidatesByOrigin = new Map<number, number[]>();
  for (const p of candidatePairs) {
    const list = candidatesByOrigin.get(p.fromCacheId);
    if (list) list.push(p.toCacheId);
    else candidatesByOrigin.set(p.fromCacheId, [p.toCacheId]);
  }

  // 2a. Pull cached cells first — anything missing goes to OSRM.
  const cached = await deps.routing.findMatrixCells(candidatePairs, profile);
  const cachedKey = (from: number, to: number) => `${from}:${to}`;
  const cachedMap = new Map<
    string,
    { meters: number; seconds: number }
  >();
  for (const c of cached) {
    cachedMap.set(cachedKey(c.fromCacheId, c.toCacheId), {
      meters: c.meters,
      seconds: c.seconds,
    });
  }

  // 2b. Fetch missing cells from OSRM, one /table per origin.
  // `[origin, ...candidates]` — we only read row 0 of the returned matrix.
  const toPersist: Array<{
    fromCacheId: number;
    toCacheId: number;
    profile: Routing.RoutingProfile;
    meters: number;
    seconds: number;
  }> = [];

  const origins = Array.from(candidatesByOrigin.keys());
  for (let i = 0; i < origins.length; i += concurrency) {
    const batch = origins.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (originId) => {
        const cands = candidatesByOrigin.get(originId)!;
        // Pure-cache hit fast path: nothing missing for this origin.
        const missing = cands.filter(
          (toId) => !cachedMap.has(cachedKey(originId, toId)),
        );
        if (missing.length === 0) return;

        const originCoord = coordsById.get(originId);
        if (!originCoord) return;
        const missingCoords = missing
          .map((id) => coordsById.get(id))
          .filter((c): c is [number, number] => c !== undefined);
        if (missingCoords.length === 0) return;

        const matrix = await deps.osrm.table(
          [originCoord, ...missingCoords],
          profile,
        );
        const row0 = matrix[0];
        if (!row0) return;
        for (let j = 0; j < missing.length; j += 1) {
          const cell = row0[j + 1]; // skip diagonal (origin → origin)
          const toId = missing[j]!;
          if (cell) {
            cachedMap.set(cachedKey(originId, toId), cell);
            toPersist.push({
              fromCacheId: originId,
              toCacheId: toId,
              profile,
              meters: cell.meters,
              seconds: cell.seconds,
            });
          }
        }
      }),
    );
  }

  if (toPersist.length > 0) {
    logger.debug(
      `walking-graph: persisting ${toPersist.length} new matrix cells to route_legs`,
    );
    await deps.routing.upsertMatrixCells(toPersist);
  }

  // 3. Re-rank each origin's candidates by walking distance, drop anything
  //    over the hard maxEdgeMeters cap, keep top kTarget. Dropping detours
  //    that exceed the cap is what prevents Louvain from fusing communities
  //    via a single river-crossing edge.
  const kNN = new Map<
    number,
    Array<{ to: number; meters: number; seconds: number }>
  >();
  let droppedFar = 0;
  for (const [originId, cands] of candidatesByOrigin) {
    const ranked: Array<{ to: number; meters: number; seconds: number }> = [];
    for (const toId of cands) {
      const cell = cachedMap.get(cachedKey(originId, toId));
      if (!cell) continue;
      if (cell.meters > maxEdgeMeters) {
        droppedFar += 1;
        continue;
      }
      ranked.push({ to: toId, meters: cell.meters, seconds: cell.seconds });
    }
    ranked.sort((a, b) => a.meters - b.meters);
    kNN.set(originId, ranked.slice(0, kTarget));
  }
  if (droppedFar > 0) {
    logger.debug(
      `walking-graph: dropped ${droppedFar} candidate edges exceeding maxEdgeMeters=${maxEdgeMeters}`,
    );
  }

  // 4. Symmetrise: keep edge (a,b) if b ∈ kNN(a) OR a ∈ kNN(b). The graph
  // is treated as undirected downstream; we emit one canonical direction
  // with the average of the two walking weights to absorb OSRM asymmetry.
  const edges = new Map<string, WalkingEdge>();
  const orderedKey = (a: number, b: number) =>
    a < b ? `${a}:${b}` : `${b}:${a}`;

  for (const [originId, kn] of kNN) {
    for (const { to, meters, seconds } of kn) {
      const key = orderedKey(originId, to);
      const existing = edges.get(key);
      if (existing) {
        // Reverse direction was already inserted; average the two
        // (handles OSRM walking asymmetry from one-way stairs etc.).
        existing.meters = (existing.meters + meters) / 2;
        existing.seconds = (existing.seconds + seconds) / 2;
      } else {
        const [from, dest] =
          originId < to ? [originId, to] : [to, originId];
        edges.set(key, {
          fromCacheId: from,
          toCacheId: dest,
          meters,
          seconds,
        });
      }
    }
  }

  return Array.from(edges.values());
}
