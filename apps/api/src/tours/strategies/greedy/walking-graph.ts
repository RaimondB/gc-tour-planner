// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Logger } from "@nestjs/common";
import type { Routing } from "@gctp/shared";
import type { CachesRepository } from "../../../caches/caches.repository.js";
import {
  HIGH_DETOUR_REJECT,
  isImpossibleDetour,
  isImpossibleSpeed,
} from "../../../routing/leg-sanity.js";
import type { OsrmClient } from "../../../routing/osrm.client.js";
import type { RoutingRepository } from "../../../routing/routing.repository.js";
import { haversineMeters } from "./equirectangular.js";

/**
 * A cached cell is treated as bogus and dropped when its walking distance is
 * effectively zero (≤ this threshold) AND the two cache coordinates are more
 * than `SUSPICIOUS_HAVERSINE_M` apart — OSRM doesn't legitimately return 0
 * for distinct, non-co-located coordinates. The threshold pair leaves room
 * for genuinely co-located multi-stage caches (two stages at the same building
 * entrance can really walk 0 m between them).
 */
const SUSPICIOUS_WALKING_M = 5;
const SUSPICIOUS_HAVERSINE_M = 50;

function haversineLngLat(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  return haversineMeters(a, b);
}

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
  /**
   * Identifier of the live OSRM extract — every cached row is tagged with
   * this so reads from a previous extract are filtered out automatically.
   * Forwarded from `OsrmVersionService.getVersion()`.
   */
  osrmVersion: string;
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
  const {
    caches,
    kTarget,
    radiusM,
    maxEdgeMeters,
    profile,
    ownerId,
    osrmVersion,
  } = input;
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

  // 2a. Pull cached cells first — anything missing goes to OSRM. Scoped to
  //     the live OSRM extract; cells from a previous extract are filtered
  //     out at the SQL level so we re-fetch them into the live namespace.
  const cached = await deps.routing.findMatrixCells(
    candidatePairs,
    profile,
    osrmVersion,
  );
  const cachedKey = (from: number, to: number) => `${from}:${to}`;
  const cachedMap = new Map<
    string,
    { meters: number; seconds: number }
  >();
  // Negative cache: pairs we've already asked OSRM about and got a
  // noroute response for. Without this, every cluster discovery
  // re-asks OSRM for the same unreachable pairs because precompute
  // can't store them in `route_legs` via the normal upsert path
  // (meters NOT NULL on a noroute row violates the schema). The
  // 1779640000000_route_legs_noroute migration added a 'noroute'
  // sentinel source so we can record the negative result.
  const cachedNoRoute = new Set<string>();
  for (const c of cached) {
    const key = cachedKey(c.fromCacheId, c.toCacheId);
    if (c.noroute) {
      cachedNoRoute.add(key);
    } else {
      cachedMap.set(key, {
        meters: c.meters,
        seconds: c.seconds,
      });
    }
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
  const toPersistNoRoute: Array<{
    fromCacheId: number;
    toCacheId: number;
    profile: Routing.RoutingProfile;
  }> = [];

  const origins = Array.from(candidatesByOrigin.keys());
  for (let i = 0; i < origins.length; i += concurrency) {
    const batch = origins.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (originId) => {
        const cands = candidatesByOrigin.get(originId)!;
        // Pure-cache hit fast path: nothing missing for this origin.
        const missing = cands.filter((toId) => {
          const k = cachedKey(originId, toId);
          // Skip pairs already in either cache — real ones AND known
          // negatives. Both count as resolved for the purpose of
          // bouncing the request back to OSRM.
          return !cachedMap.has(k) && !cachedNoRoute.has(k);
        });
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
          if (!cell) {
            // OSRM said no route. Record the negative so the next
            // discovery doesn't re-ask. Stamped with the current
            // osrm_version so a fresh extract naturally invalidates
            // these (a network edit might unblock the pair).
            cachedNoRoute.add(cachedKey(originId, toId));
            toPersistNoRoute.push({
              fromCacheId: originId,
              toCacheId: toId,
              profile,
            });
            continue;
          }
          // Reject suspicious zero-distance cells at write time so they never
          // pollute route_legs in the first place. Comes up when OSRM snaps
          // two distinct cache coords to the same road node — the matrix cell
          // is then 0/0 and indistinguishable from a real link.
          const toCoord = coordsById.get(toId);
          if (
            cell.meters <= SUSPICIOUS_WALKING_M &&
            toCoord &&
            haversineLngLat(originCoord, toCoord) >= SUSPICIOUS_HAVERSINE_M
          ) {
            continue;
          }
          // Hard-reject impossible walking speeds and outrageous detours
          // before they hit the cache or the clustering input. The repo
          // layer enforces the speed guard at the DB boundary too — this
          // upstream check just keeps the rejected count visible in the
          // walking-graph stats.
          if (isImpossibleSpeed(cell.meters, cell.seconds)) continue;
          if (
            toCoord &&
            isImpossibleDetour(cell.meters, haversineLngLat(originCoord, toCoord))
          ) {
            continue;
          }
          cachedMap.set(cachedKey(originId, toId), cell);
          toPersist.push({
            fromCacheId: originId,
            toCacheId: toId,
            profile,
            meters: cell.meters,
            seconds: cell.seconds,
          });
        }
      }),
    );
  }

  if (toPersist.length > 0) {
    logger.debug(
      `walking-graph: persisting ${toPersist.length} new matrix cells to route_legs`,
    );
    await deps.routing.upsertMatrixCells(toPersist, osrmVersion);
  }
  if (toPersistNoRoute.length > 0) {
    logger.debug(
      `walking-graph: persisting ${toPersistNoRoute.length} noroute markers to route_legs`,
    );
    await deps.routing.upsertNorouteCells(toPersistNoRoute, osrmVersion);
  }

  // 3. Re-rank each origin's candidates by walking distance, drop anything
  //    over the hard maxEdgeMeters cap, keep top kTarget. Dropping detours
  //    that exceed the cap is what prevents Louvain from fusing communities
  //    via a single river-crossing edge.
  //
  //    Also drop **suspicious zero-distance cells**: a `route_legs` row of
  //    meters≈0 for caches more than SUSPICIOUS_HAVERSINE_M apart is almost
  //    certainly stale data from an earlier bad OSRM response (and INSERT …
  //    DO NOTHING means it never gets corrected). These cells artificially
  //    inflate node degree inside dense pockets and starve the long-range
  //    connections that would normally bridge to neighbouring pockets.
  const kNN = new Map<
    number,
    Array<{ to: number; meters: number; seconds: number }>
  >();
  let droppedFar = 0;
  let droppedBogusZero = 0;
  let droppedImpossibleSpeed = 0;
  let droppedHighDetour = 0;
  for (const [originId, cands] of candidatesByOrigin) {
    const originCoord = coordsById.get(originId);
    const ranked: Array<{ to: number; meters: number; seconds: number }> = [];
    for (const toId of cands) {
      const cell = cachedMap.get(cachedKey(originId, toId));
      if (!cell) continue;
      if (cell.meters > maxEdgeMeters) {
        droppedFar += 1;
        continue;
      }
      if (cell.meters <= SUSPICIOUS_WALKING_M && originCoord) {
        const toCoord = coordsById.get(toId);
        if (toCoord && haversineLngLat(originCoord, toCoord) >= SUSPICIOUS_HAVERSINE_M) {
          droppedBogusZero += 1;
          continue;
        }
      }
      if (isImpossibleSpeed(cell.meters, cell.seconds)) {
        droppedImpossibleSpeed += 1;
        continue;
      }
      if (originCoord) {
        const toCoord = coordsById.get(toId);
        if (
          toCoord &&
          isImpossibleDetour(cell.meters, haversineLngLat(originCoord, toCoord))
        ) {
          droppedHighDetour += 1;
          continue;
        }
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
  if (droppedBogusZero > 0) {
    logger.warn(
      `walking-graph: dropped ${droppedBogusZero} SUSPICIOUS zero-distance cells ` +
        `(walkingM ≤ ${SUSPICIOUS_WALKING_M} m but haversine ≥ ${SUSPICIOUS_HAVERSINE_M} m). ` +
        `These look like stale route_legs rows — purge them with ` +
        `\`DELETE FROM route_legs WHERE meters <= ${SUSPICIOUS_WALKING_M}\` to force a refetch from OSRM.`,
    );
  }
  if (droppedImpossibleSpeed > 0) {
    logger.warn(
      `walking-graph: dropped ${droppedImpossibleSpeed} cells with impossible walking speed`,
    );
  }
  if (droppedHighDetour > 0) {
    logger.warn(
      `walking-graph: dropped ${droppedHighDetour} cells with walking/haversine ratio > ${HIGH_DETOUR_REJECT}`,
    );
  }

  // 4. Symmetrise — MIN of the two directions.
  //
  // Walking is structurally bidirectional: pedestrians ignore one-way road
  // tags, stairs work in both directions, etc. Heavy OSRM asymmetries (e.g.
  // 658 m one way vs 1864 m the other for a 594 m haversine pair, or
  // 851 m vs 7713 m) almost always mean the larger value is an OSRM
  // artefact — wrong snap, detour around a one-way restriction that doesn't
  // apply to foot traffic, missing pedestrian crossing forcing a long
  // bypass. The honest walking distance is the smaller of the two.
  //
  // Per-cell sanity (impossible speed, > 10× detour) already rejected the
  // pathological cases at fetch time, so a MIN that survives those checks
  // is a real walking distance.
  //
  // Admission rule: an edge enters the graph if its forward direction is
  // in some origin's top-k (which already implies forward ≤ maxEdgeMeters
  // and per-cell sanity). The reverse direction is consulted only to take
  // MIN — we no longer let a bad reverse value gate admission. This is the
  // explicit reversal of the earlier MAX policy (commit 51eac59).
  const orderedKey = (a: number, b: number) =>
    a < b ? `${a}:${b}` : `${b}:${a}`;

  const edges = new Map<string, WalkingEdge>();
  let asymmetricMinSelected = 0;
  for (const [originId, kn] of kNN) {
    for (const { to, meters, seconds } of kn) {
      const reverse = cachedMap.get(cachedKey(to, originId));
      const minMeters = reverse ? Math.min(meters, reverse.meters) : meters;
      const minSeconds = reverse ? Math.min(seconds, reverse.seconds) : seconds;
      // Track how often MIN picked the meaningfully-cheaper direction —
      // pure diagnostic, doesn't change behaviour.
      if (reverse && Math.abs(meters - reverse.meters) / minMeters > 0.5) {
        asymmetricMinSelected += 1;
      }
      const key = orderedKey(originId, to);
      if (edges.has(key)) continue; // already inserted from the other direction
      const [from, dest] = originId < to ? [originId, to] : [to, originId];
      edges.set(key, {
        fromCacheId: from,
        toCacheId: dest,
        meters: minMeters,
        seconds: minSeconds,
      });
    }
  }

  if (asymmetricMinSelected > 0) {
    logger.debug(
      `walking-graph: ${asymmetricMinSelected} edges where MIN(forward, reverse) was > 50 % smaller than MAX — taking MIN as the walking-honest distance`,
    );
  }

  return Array.from(edges.values());
}
