// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Logger } from "@nestjs/common";
import { Geo, type Routing, type Tours } from "@gctp/shared";
import type { CacheLanduseRepository } from "../../../../caches/cache-landuse.repository.js";
import type { CachesRepository } from "../../../../caches/caches.repository.js";
import type { CachesService } from "../../../../caches/caches.service.js";
import type { OsrmClient } from "../../../../routing/osrm.client.js";
import type { OsrmVersionService } from "../../../../routing/osrm-version.service.js";
import type { RoutingRepository } from "../../../../routing/routing.repository.js";
import { extractSeedSubgraphs, selectSeeds } from "../seeds.js";
import { buildWalkingGraph, type WalkingEdge } from "../walking-graph.js";
import type { ClusteringContext } from "./strategy.js";

const PROFILE: Routing.RoutingProfile = "foot";
const MAX_DISCOVERY_POOL = 2_000;
const KNN_TARGET = Number.parseInt(process.env.PLANNER_KNN_K ?? "12", 10);

export interface PreparedContext extends ClusteringContext {
  /** Bytes returned alongside diagnostics — not used by strategies. */
  landuseKindsByCacheId: ReadonlyMap<number, readonly string[]>;
}

/**
 * Build the candidate-pool + walking-graph + seed-subgraph context that every
 * clustering strategy consumes. Pure Pass-1 prelude — no scoring, no trim.
 * Extracted from `GreedyTspPlanner.discoverClusters` so the explain endpoint
 * can share it without duplicating OSRM/DB work.
 */
export async function prepareClusteringContext(
  ownerId: string,
  input: Tours.PlanInput,
  deps: {
    caches: CachesService;
    cachesRepo: CachesRepository;
    cacheLanduse: CacheLanduseRepository;
    routingRepo: RoutingRepository;
    osrm: OsrmClient;
    osrmVersion: OsrmVersionService;
    logger: Logger;
  },
): Promise<PreparedContext | null> {
  const { caches } = await deps.caches.list(ownerId, {
    center: input.center,
    radiusM: input.radiusM,
    types: input.hardFilters.types,
    attributes: input.hardFilters.attributes,
    // Forward the map's filters so the clustered pool == the visible set.
    solvedMysteriesOnly: input.hardFilters.solvedMysteriesOnly,
    multiSubtype: input.hardFilters.multiSubtype,
    hideToolCaches: input.hardFilters.hideToolCaches,
    contexts: input.hardFilters.contexts,
    // Implicit: never plan a tour to caches the user has already found, even
    // when the map is showing them (dimmed). This is the one deliberate
    // pool-vs-map divergence.
    excludeFound: true,
  });
  if (caches.length < 2) return null;

  const pool = caches.slice(0, MAX_DISCOVERY_POOL);
  if (caches.length > MAX_DISCOVERY_POOL) {
    deps.logger.warn(
      `prepareClusteringContext: ${caches.length} candidates exceeds MAX_DISCOVERY_POOL=${MAX_DISCOVERY_POOL}; trimming.`,
    );
  }
  const coordinated = pool.map((c) => ({
    id: c.id,
    lng: c.location.coordinates[0]!,
    lat: c.location.coordinates[1]!,
  }));

  const bbox = bboxOf(coordinated);
  await deps.cacheLanduse
    .populateForBbox(bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat)
    .catch((err) =>
      deps.logger.warn(
        `cache_landuse populate failed (degrading gracefully): ${(err as Error).message}`,
      ),
    );
  const landuseKindsByCacheId = await deps.cacheLanduse.kindsByCacheId(
    pool.map((c) => c.id),
  );

  const edges: WalkingEdge[] = await buildWalkingGraph(
    {
      ownerId,
      caches: coordinated,
      kTarget: KNN_TARGET,
      radiusM: Math.min(input.maxLinkMeters * 2, 4_000),
      maxEdgeMeters: input.maxLinkMeters,
      profile: PROFILE,
      osrmVersion: deps.osrmVersion.getVersion(),
    },
    { caches: deps.cachesRepo, routing: deps.routingRepo, osrm: deps.osrm },
  );

  const seedIds = selectSeeds(coordinated, edges);
  const subgraphs = extractSeedSubgraphs(
    seedIds,
    edges,
    input.distanceBudgetMeters,
  );

  return {
    pool,
    coordinated,
    edges,
    subgraphs,
    input,
    projection: Geo.makeProjection(input.center[0], input.center[1]),
    landuseKindsByCacheId,
  };
}

function bboxOf(coords: readonly { lng: number; lat: number }[]): {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
} {
  let minLng = coords[0]?.lng ?? 0;
  let minLat = coords[0]?.lat ?? 0;
  let maxLng = minLng;
  let maxLat = minLat;
  for (const c of coords) {
    if (c.lng < minLng) minLng = c.lng;
    if (c.lng > maxLng) maxLng = c.lng;
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}
