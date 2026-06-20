// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Logger } from "@nestjs/common";
import { Geo, Tours, type Routing } from "@gctp/shared";
import type { CacheLanduseRepository } from "../../../../caches/cache-landuse.repository.js";
import type { CachesRepository } from "../../../../caches/caches.repository.js";
import type { CachesService } from "../../../../caches/caches.service.js";
import type { OsrmClient } from "../../../../routing/osrm.client.js";
import type { OsrmVersionService } from "../../../../routing/osrm-version.service.js";
import type { RoutingRepository } from "../../../../routing/routing.repository.js";
import { extractSeedSubgraphs, selectSeeds } from "../seeds.js";
import {
  buildWalkingGraph,
  type WalkingEdge,
  type WalkingGraphStats,
} from "../walking-graph.js";
import { selectGrowthPool } from "./growth-pool.js";
import { collapseAdventures } from "../collapse-adventures.js";
import type { ClusteringContext } from "./strategy.js";

/** Boundary-spanning clusters (ADR-0026). Default-off. */
function readClusterGrow(): boolean {
  const v = process.env.PLANNER_CLUSTER_GROW;
  return v === "1" || v === "true";
}

const PROFILE: Routing.RoutingProfile = "foot";
const MAX_DISCOVERY_POOL = 2_000;
const KNN_TARGET = Number.parseInt(process.env.PLANNER_KNN_K ?? "12", 10);

/**
 * Walking-graph symmetry rule. `or` (default, legacy): an edge survives if
 * EITHER endpoint ranks the other in its k-NN. `mutual` ("dual-link"): the edge
 * survives only if BOTH rank each other, with a min-degree floor so a node is
 * never orphaned. Mutual sharpens cluster separation (kills one-way hub links)
 * at some recall cost in sparse areas. Read once; A/B via the explain endpoint.
 */
const KNN_SYMMETRY: "or" | "mutual" =
  process.env.PLANNER_KNN_SYMMETRY === "mutual" ? "mutual" : "or";

/**
 * Min-degree floor for mutual symmetry (default 1 = never orphan). 2 tops each
 * node up to its two nearest edges, trading a little tightness back for cluster
 * coverage. Ignored when `KNN_SYMMETRY` is `or`.
 */
const KNN_MUTUAL_FLOOR = Number.parseInt(
  process.env.PLANNER_KNN_MUTUAL_FLOOR ?? "1",
  10,
);

export interface PreparedContext extends ClusteringContext {
  /** Bytes returned alongside diagnostics — not used by strategies. */
  landuseKindsByCacheId: ReadonlyMap<number, readonly string[]>;
  /**
   * Adventure-collapse expansion (FR-I17): representative cache id → all of that
   * adventure's stage ids. Pass-1 clusters on the representatives (one node per
   * adventure); `computeClusters` expands each chosen cluster's ids back to
   * every stage on output. Empty when no Adventure Labs are in the pool.
   */
  adventureExpansion: ReadonlyMap<number, number[]>;
}

/**
 * Optional phase-timing breakdown for the Pass-1 context build. Pass an empty
 * object as `prepareClusteringContext`'s 4th arg and it is mutated in place with
 * per-phase wall-clock (ms), the candidate/pool sizes, and the nested
 * walking-graph stats. Lets a bench attribute discovery latency without timing
 * logs in the production path. Zero-overhead when omitted. See the
 * discovery-timing bench + the perf handoff: the OSRM `/table` fan-out inside
 * `walking.osrmFetchMs` dominates a cold/dense pool.
 */
export interface ContextStats {
  /** Candidates returned by `caches.list` before the MAX_DISCOVERY_POOL cap. */
  candidateCount: number;
  /** Pool size after the proximity cap (== number of walking-graph origins). */
  poolSize: number;
  /** `caches.list` DB pull of the candidate pool. */
  listMs: number;
  /** Landuse populate + kinds lookup over the pool bbox. */
  landuseMs: number;
  /** `buildWalkingGraph` total (sum of `walking.*` phase fields). */
  walkingGraphMs: number;
  /** Seed selection + subgraph extraction (cheap). */
  seedsMs: number;
  /** Nested walking-graph phase breakdown. */
  walking: Partial<WalkingGraphStats>;
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
  // Optional phase-timing sink; mutated in place when provided (zero-overhead
  // otherwise). See ContextStats / the discovery-timing bench.
  stats?: Partial<ContextStats>,
): Promise<PreparedContext | null> {
  const clock = () => performance.now();
  // Boundary-spanning clusters (ADR-0026): when enabled, fetch caches out to
  // `radiusM + distanceBudgetMeters/2` — the farthest a cache can sit and still
  // join a budget-valid loop anchored on an in-radius seed — so a cluster that
  // straddles the search circle is fully detected instead of truncated at the
  // boundary. Seeds stay in-radius (clusters originate in the search area) and
  // the walking graph is constrained to the pool, so the refine→pool invariant
  // holds by construction. `grow=false` reproduces the legacy radius exactly.
  const grow = readClusterGrow();
  // Shared contract with the web client — see Tours.clusterGrowthMarginMeters.
  const growthMarginM = grow
    ? Tours.clusterGrowthMarginMeters(input.distanceBudgetMeters)
    : 0;

  const tList = clock();
  const { caches } = await deps.caches.list(ownerId, {
    center: input.center,
    radiusM: input.radiusM + growthMarginM,
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

  // Collapse each Adventure Lab's stages into one representative node (FR-I17)
  // BEFORE the pool cap and the walking graph, so an adventure counts as a
  // single place rather than 5-10 near-co-located caches that would otherwise
  // form their own dense micro-cluster. The chosen cluster's ids are expanded
  // back to every stage in `computeClusters`. No-op when no AL is in the pool.
  const { collapsed, expansion: adventureExpansion } =
    collapseAdventures(caches);
  if (collapsed.length < caches.length) {
    deps.logger.debug(
      `adventure collapse: ${caches.length - collapsed.length} AL stage(s) → ${adventureExpansion.size} adventure node(s)`,
    );
  }
  if (stats) {
    stats.listMs = clock() - tList;
    // Candidate count reflects what clustering actually operates on (post-collapse).
    stats.candidateCount = collapsed.length;
  }
  if (collapsed.length < 2) return null;

  // Cap by proximity to the centre so the in-radius seed set + the nearest halo
  // survive the cap; `inRadiusIds` is the seed-eligible subset.
  const { pool, inRadiusIds } = selectGrowthPool(
    collapsed,
    input.center,
    input.radiusM,
    MAX_DISCOVERY_POOL,
  );
  if (pool.length < 2) return null;
  if (collapsed.length > pool.length) {
    deps.logger.warn(
      `prepareClusteringContext: ${collapsed.length} candidates exceeds MAX_DISCOVERY_POOL=${MAX_DISCOVERY_POOL}; trimming to nearest ${pool.length}.`,
    );
  }
  const coordinated = pool.map((c) => ({
    id: c.id,
    lng: c.location.coordinates[0]!,
    lat: c.location.coordinates[1]!,
  }));

  if (stats) stats.poolSize = pool.length;

  const tLanduse = clock();
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
  if (stats) stats.landuseMs = clock() - tLanduse;

  const walkingStats: Partial<WalkingGraphStats> | undefined = stats
    ? {}
    : undefined;
  const tGraph = clock();
  const edges: WalkingEdge[] = await buildWalkingGraph(
    {
      ownerId,
      caches: coordinated,
      kTarget: KNN_TARGET,
      radiusM: Math.min(input.maxLinkMeters * 2, 4_000),
      maxEdgeMeters: input.maxLinkMeters,
      profile: PROFILE,
      osrmVersion: deps.osrmVersion.getVersion(),
      poolOnly: grow,
      symmetry: KNN_SYMMETRY,
      mutualFloor: KNN_MUTUAL_FLOOR,
    },
    { caches: deps.cachesRepo, routing: deps.routingRepo, osrm: deps.osrm },
    undefined,
    walkingStats,
  );
  if (stats) {
    stats.walkingGraphMs = clock() - tGraph;
    stats.walking = walkingStats;
  }

  // Seeds come from the in-radius subset only, so clusters originate inside the
  // search circle even when the pool extends past it. With grow off the pool is
  // entirely in-radius, so this is a no-op.
  const tSeeds = clock();
  const seedIds = selectSeeds(
    coordinated.filter((c) => inRadiusIds.has(c.id)),
    edges,
  );
  const subgraphs = extractSeedSubgraphs(
    seedIds,
    edges,
    input.distanceBudgetMeters,
  );
  if (stats) stats.seedsMs = clock() - tSeeds;

  return {
    pool,
    coordinated,
    edges,
    subgraphs,
    input,
    projection: Geo.makeProjection(input.center[0], input.center[1]),
    landuseKindsByCacheId,
    adventureExpansion,
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
