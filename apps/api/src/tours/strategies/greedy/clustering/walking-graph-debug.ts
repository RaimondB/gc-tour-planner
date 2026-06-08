// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Logger } from "@nestjs/common";
import type { Tours } from "@gctp/shared";
import type { CacheLanduseRepository } from "../../../../caches/cache-landuse.repository.js";
import type { CachesRepository } from "../../../../caches/caches.repository.js";
import type { CachesService } from "../../../../caches/caches.service.js";
import type { OsrmClient } from "../../../../routing/osrm.client.js";
import type { OsrmVersionService } from "../../../../routing/osrm-version.service.js";
import type { RoutingRepository } from "../../../../routing/routing.repository.js";
import { haversineMeters } from "../equirectangular.js";
import { prepareClusteringContext } from "./context.js";

/**
 * Threshold below which a walking distance is treated as bogus *if* the two
 * caches are clearly not co-located. OSRM legitimately returns small numbers
 * for caches that snap to the same road node (e.g. multi-stage caches at the
 * same building entrance), so we only flag when the straight-line distance
 * far exceeds the reported walk.
 */
export const SUSPICIOUS_WALKING_M = 5;
export const SUSPICIOUS_HAVERSINE_M = 50;

/**
 * Detour-ratio thresholds for the coverage-warning heuristic. Picked from
 * a quick survey of healthy OSRM extracts (median ~1.2-1.5, p95 ~2.5) vs.
 * the broken NL-only extract used while debugging the cross-border case
 * (median ~3-4, many > 10). Tune if real-world data shows false positives.
 */
const HIGH_DETOUR_THRESHOLD = 4;
const MEDIAN_DETOUR_WARN = 2.5;
const HIGH_DETOUR_FRACTION_WARN = 0.25;

const logger = new Logger("WalkingGraphDebug");

export async function buildWalkingGraphResponse(
  ownerId: string,
  input: Tours.WalkingGraphInput,
  deps: {
    caches: CachesService;
    cachesRepo: CachesRepository;
    cacheLanduse: CacheLanduseRepository;
    routingRepo: RoutingRepository;
    osrm: OsrmClient;
    osrmVersion: OsrmVersionService;
  },
): Promise<Tours.WalkingGraphResponse> {
  const planInput: Tours.PlanInput = {
    center: input.center,
    radiusM: input.radiusM,
    maxCaches: 50,
    minClusterSize: 2,
    maxLinkMeters: input.maxLinkMeters,
    distanceBudgetMeters: input.distanceBudgetMeters,
    hardFilters: input.hardFilters,
    softPreferences: {
      clusterDensityWeight: 1,
      loopCompactnessWeight: 1,
      landuseWeight: 1,
    },
    startPreference: "parking-waypoint",
    osmParkingAccessFilter: ["yes", "customers"],
    osmParkingFeeFilter: "any",
    topNClusters: 5,
  };
  const ctx = await prepareClusteringContext(ownerId, planInput, {
    caches: deps.caches,
    cachesRepo: deps.cachesRepo,
    cacheLanduse: deps.cacheLanduse,
    routingRepo: deps.routingRepo,
    osrm: deps.osrm,
    osrmVersion: deps.osrmVersion,
    logger,
  });
  if (!ctx) {
    return {
      nodes: [],
      edges: [],
      stats: {
        nodeCount: 0,
        edgeCount: 0,
        isolatedCount: 0,
        suspiciousCount: 0,
        medianEdgeM: 0,
        maxEdgeM: 0,
        medianDetourRatio: 0,
        highDetourCount: 0,
        coverageWarning: false,
      },
    };
  }

  const poolById = new Map(ctx.pool.map((c) => [c.id, c]));
  const degree = new Map<number, number>();
  for (const c of ctx.pool) degree.set(c.id, 0);
  for (const e of ctx.edges) {
    degree.set(e.fromCacheId, (degree.get(e.fromCacheId) ?? 0) + 1);
    degree.set(e.toCacheId, (degree.get(e.toCacheId) ?? 0) + 1);
  }

  const nodes: Tours.WalkingGraphNode[] = ctx.pool.map((c) => ({
    id: c.id,
    code: c.code,
    lng: round6(c.location.coordinates[0]!),
    lat: round6(c.location.coordinates[1]!),
    degree: degree.get(c.id) ?? 0,
  }));

  const edges: Tours.WalkingGraphEdge[] = ctx.edges.map((e) => {
    const ca = poolById.get(e.fromCacheId);
    const cb = poolById.get(e.toCacheId);
    const haversine =
      ca && cb
        ? haversineMeters(
            [ca.location.coordinates[0]!, ca.location.coordinates[1]!],
            [cb.location.coordinates[0]!, cb.location.coordinates[1]!],
          )
        : 0;
    // ctx.edges has already been filtered by the read-time suspicious guard,
    // so anything reaching this branch is by definition NOT suspicious. We
    // still recompute the flag (it's cheap) in case the thresholds drift.
    const suspicious =
      e.meters <= SUSPICIOUS_WALKING_M && haversine >= SUSPICIOUS_HAVERSINE_M;
    return {
      a: e.fromCacheId,
      b: e.toCacheId,
      walkingM: round2(e.meters),
      walkingS: round2(e.seconds),
      haversineM: round2(haversine),
      suspicious,
    };
  });

  // Surface the stale `route_legs` rows the planner now filters out, so the
  // UI can both visualise them (dashed red) and offer a Purge button. Without
  // this round-trip the user never sees that the DB is polluted — the
  // planner has already swallowed the noise upstream.
  const dbSuspicious = await deps.routingRepo.findSuspiciousLegs(
    ownerId,
    ctx.pool.map((c) => c.id),
    "foot",
    SUSPICIOUS_WALKING_M,
    SUSPICIOUS_HAVERSINE_M,
    deps.osrmVersion.getVersion(),
  );
  // Dedup against any directional duplicates and edges already in `edges`.
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const seen = new Set(edges.map((e) => edgeKey(e.a, e.b)));
  for (const s of dbSuspicious) {
    const key = edgeKey(s.fromCacheId, s.toCacheId);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      a: s.fromCacheId,
      b: s.toCacheId,
      walkingM: round2(s.meters),
      walkingS: round2(s.seconds),
      haversineM: round2(s.haversineM),
      suspicious: true,
    });
  }
  const suspiciousCount = edges.filter((e) => e.suspicious).length;

  const meters = edges.map((e) => e.walkingM).sort((a, b) => a - b);
  const median =
    meters.length === 0 ? 0 : (meters[Math.floor(meters.length / 2)] ?? 0);
  const max = meters.length === 0 ? 0 : (meters.at(-1) ?? 0);
  const isolatedCount = nodes.filter((n) => n.degree === 0).length;

  // Detour-ratio diagnostics. Skip suspicious edges (they have walkingM≈0,
  // which would dominate the distribution with infinite ratios) and skip
  // edges whose haversine is < 25 m (numerical noise / co-located stages).
  const ratios: number[] = [];
  let highDetourCount = 0;
  for (const e of edges) {
    if (e.suspicious) continue;
    if (e.haversineM < 25) continue;
    if (e.walkingM <= 0) continue;
    const r = e.walkingM / e.haversineM;
    ratios.push(r);
    if (r > HIGH_DETOUR_THRESHOLD) highDetourCount += 1;
  }
  ratios.sort((a, b) => a - b);
  const medianDetourRatio =
    ratios.length === 0 ? 0 : (ratios[Math.floor(ratios.length / 2)] ?? 0);
  const highDetourFraction =
    ratios.length === 0 ? 0 : highDetourCount / ratios.length;
  const coverageWarning =
    ratios.length >= 5 &&
    (medianDetourRatio > MEDIAN_DETOUR_WARN ||
      highDetourFraction > HIGH_DETOUR_FRACTION_WARN);

  if (suspiciousCount > 0) {
    logger.warn(
      `walking-graph: ${suspiciousCount}/${edges.length} edges are SUSPICIOUS ` +
        `(walkingM ≤ ${SUSPICIOUS_WALKING_M} m but haversine ≥ ${SUSPICIOUS_HAVERSINE_M} m). ` +
        `These look like stale route_legs rows — DELETE them to force a re-fetch from OSRM.`,
    );
  }
  if (coverageWarning) {
    logger.warn(
      `walking-graph: COVERAGE WARNING — median detour ratio ${medianDetourRatio.toFixed(2)}, ` +
        `${highDetourCount}/${ratios.length} edges have walkingM/haversine > ${HIGH_DETOUR_THRESHOLD}. ` +
        `OSRM is likely routing around big gaps in the foot graph. ` +
        `Check that OSRM_REGION (or OSRM_REGIONS) covers your full search area.`,
    );
  }

  return {
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      isolatedCount,
      suspiciousCount,
      medianEdgeM: round2(median),
      maxEdgeM: round2(max),
      medianDetourRatio: round2(medianDetourRatio),
      highDetourCount,
      coverageWarning,
    },
  };
}

/**
 * Live OSRM probe for a single cache pair, bypassing `route_legs`. Used by
 * the Cluster Lab to answer "is OSRM the bottleneck, or is the cache?" —
 * the cached cell could be stale or capped; OSRM /route is ground truth.
 */
export async function testOsrmRoute(
  ownerId: string,
  input: Tours.TestRouteInput,
  deps: { caches: CachesService; osrm: OsrmClient },
): Promise<Tours.TestRouteResponse> {
  const rows = await deps.caches.findByIds(ownerId, [
    input.fromCacheId,
    input.toCacheId,
  ]);
  const from = rows.find((c) => c.id === input.fromCacheId);
  const to = rows.find((c) => c.id === input.toCacheId);
  if (!from || !to) {
    throw new Error(
      `Caches not found for this user: ${[
        from ? null : input.fromCacheId,
        to ? null : input.toCacheId,
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
  }
  const fromCoord: [number, number] = [
    from.location.coordinates[0]!,
    from.location.coordinates[1]!,
  ];
  const toCoord: [number, number] = [
    to.location.coordinates[0]!,
    to.location.coordinates[1]!,
  ];
  const haversine = haversineMeters(fromCoord, toCoord);
  const route = await deps.osrm.route(fromCoord, toCoord, "foot");
  return {
    fromCacheId: from.id,
    toCacheId: to.id,
    fromCode: from.code,
    toCode: to.code,
    haversineM: round2(haversine),
    route: route
      ? {
          meters: round2(route.meters),
          seconds: round2(route.seconds),
          geometry: route.geometry,
        }
      : null,
  };
}

/**
 * Live OSRM probe for `from → via → to` — powers the draggable via-point
 * edit UI. Bypasses `route_legs` (every drag position is unique, so the
 * cache would never hit) and bypasses the route_legs SAVE path (we don't
 * want to pollute the cache with a key=(from,to) row whose stored
 * geometry depends on an ephemeral via position the next caller won't
 * know about).
 *
 * Returns `route: null` when OSRM responds NoRoute — the UI keeps the
 * previous-successful geometry on screen and tints the marker so the
 * user can see they've dragged into an unrouteable spot.
 */
export async function viaRoute(
  ownerId: string,
  input: Tours.ViaRouteInput,
  deps: { caches: CachesService; osrm: OsrmClient },
): Promise<Tours.ViaRouteResponse> {
  const rows = await deps.caches.findByIds(ownerId, [
    input.fromCacheId,
    input.toCacheId,
  ]);
  const from = rows.find((c) => c.id === input.fromCacheId);
  const to = rows.find((c) => c.id === input.toCacheId);
  if (!from || !to) {
    throw new Error(
      `Caches not found for this user: ${[
        from ? null : input.fromCacheId,
        to ? null : input.toCacheId,
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
  }
  const fromCoord: [number, number] = [
    from.location.coordinates[0]!,
    from.location.coordinates[1]!,
  ];
  const toCoord: [number, number] = [
    to.location.coordinates[0]!,
    to.location.coordinates[1]!,
  ];
  const via: [number, number] = [input.via[0], input.via[1]];
  const route = await deps.osrm.routeMulti([fromCoord, via, toCoord], "foot");
  return {
    fromCacheId: from.id,
    toCacheId: to.id,
    fromCode: from.code,
    toCode: to.code,
    route: route
      ? {
          meters: round2(route.meters),
          seconds: round2(route.seconds),
          geometry: route.geometry,
        }
      : null,
  };
}

/**
 * Delete stale `route_legs` rows with bogus zero-ish walking distance for the
 * caches currently in the search area's pool. Forces a refetch from OSRM on
 * the next planner pass. Returns the count of rows deleted.
 */
export async function purgeBogusWalkingCells(
  ownerId: string,
  input: Tours.PurgeBogusInput,
  deps: {
    caches: CachesService;
    routingRepo: RoutingRepository;
    osrmVersion: OsrmVersionService;
  },
): Promise<Tours.PurgeBogusResponse> {
  const { caches } = await deps.caches.list(ownerId, {
    center: input.center,
    radiusM: input.radiusM,
    types: input.hardFilters.types,
    attributes: input.hardFilters.attributes,
    solvedMysteriesOnly: input.hardFilters.solvedMysteriesOnly,
    multiSubtype: input.hardFilters.multiSubtype,
    hideToolCaches: input.hardFilters.hideToolCaches,
    contexts: input.hardFilters.contexts,
    excludeFound: true,
  });
  if (caches.length === 0) {
    return {
      poolSize: 0,
      walkingMaxMeters: SUSPICIOUS_WALKING_M,
      haversineMinMeters: SUSPICIOUS_HAVERSINE_M,
      deletedCount: 0,
    };
  }
  const ids = caches.map((c) => c.id);
  const deletedCount = await deps.routingRepo.deleteSuspiciousLegs(
    ownerId,
    ids,
    "foot",
    SUSPICIOUS_WALKING_M,
    SUSPICIOUS_HAVERSINE_M,
    deps.osrmVersion.getVersion(),
  );
  logger.warn(
    `purge-bogus: deleted ${deletedCount} suspicious route_legs rows for ` +
      `${ids.length} caches (owner ${ownerId}). Next planner pass will refetch from OSRM.`,
  );
  return {
    poolSize: caches.length,
    walkingMaxMeters: SUSPICIOUS_WALKING_M,
    haversineMinMeters: SUSPICIOUS_HAVERSINE_M,
    deletedCount,
  };
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
