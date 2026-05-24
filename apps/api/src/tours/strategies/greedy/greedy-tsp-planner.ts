// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Caches, Geo, Routing, Tours } from "@gctp/shared";
import { Tsp } from "@gctp/shared";
import { CachesService } from "../../../caches/caches.service.js";
import { RoutingService } from "../../../routing/routing.service.js";
import { OSRM_CLIENT, type OsrmClient } from "../../../routing/osrm.client.js";
import { dbscanFromDistances } from "./dbscan.js";
import { haversineMeters } from "./equirectangular.js";

const PROFILE: Routing.RoutingProfile = "foot";
const TOP_N_CLUSTERS = 5;
/** Hard cap so a misconfigured request doesn't make the planner OOM. */
const MAX_LOOP_CACHES = 50;
/** Parking is considered "present" for a cache if a parking waypoint is within this radius of it (m). */
const PARKING_PRESENCE_RADIUS_M = 500;
/**
 * Hard cap on candidate-pool size sent to OSRM /table during cluster discovery.
 * N=300 ⇒ ~89k cells, which OSRM serves in well under a second. Bigger search
 * areas should be trimmed by the caller via radius/hardFilters.
 */
const MAX_DISCOVERY_POOL = 300;

@Injectable()
export class GreedyTspPlanner implements Tours.TourPlannerStrategy {
  private readonly logger = new Logger(GreedyTspPlanner.name);

  constructor(
    private readonly caches: CachesService,
    private readonly routing: RoutingService,
    @Inject(OSRM_CLIENT) private readonly osrm: OsrmClient,
  ) {}

  // ─── Pass 1: cluster discovery ────────────────────────────────────────────

  async discoverClusters(
    ownerId: string,
    input: Tours.PlanInput,
  ): Promise<Tours.DiscoverClustersResult> {
    const { caches } = await this.caches.list(ownerId, {
      center: input.center,
      radiusM: input.radiusM,
      types: input.hardFilters.types,
      attributes: input.hardFilters.attributes,
      // Tour planning operates on the un-found pool by default; the user can
      // still pick specific cache ids in Pass 2 if they want to revisit.
      excludeFound: true,
    });

    if (caches.length < 2) {
      this.logger.debug(
        `discoverClusters: only ${caches.length} candidate caches — returning no clusters`,
      );
      return {
        candidates: [],
        diagnostics: {
          epsilonMeters: 0,
          poolSize: caches.length,
          components: [],
          cacheConnectivity: caches.map((c) => ({
            cacheId: c.id,
            nearestWalkableMeters: null,
          })),
        },
      };
    }

    const pool = caches.slice(0, MAX_DISCOVERY_POOL);
    if (caches.length > MAX_DISCOVERY_POOL) {
      this.logger.warn(
        `discoverClusters: ${caches.length} candidates exceeds MAX_DISCOVERY_POOL=${MAX_DISCOVERY_POOL}; trimming.`,
      );
    }

    // Walking OD matrix for the entire candidate pool. One OSRM /table call.
    // This is what makes the clustering routability-aware: caches separated by
    // a river / motorway end up as `null` (unreachable on foot), and DBSCAN
    // treats them as +Infinity so they cannot cluster — Euclidean DBSCAN
    // would happily merge them, planting a centroid in the middle of an
    // unwalkable area.
    const ids = pool.map((c) => c.id);
    const matrix = await this.routing.getMatrix(ownerId, ids, PROFILE);
    const indexInMatrix = new Map<number, number>();
    matrix.cacheIds.forEach((id, i) => indexInMatrix.set(id, i));

    const walkingMeters = (a: number, b: number): number => {
      if (a === b) return 0;
      const ia = indexInMatrix.get(pool[a]!.id);
      const ib = indexInMatrix.get(pool[b]!.id);
      if (ia == null || ib == null) return Number.POSITIVE_INFINITY;
      const cell = matrix.legs[ia]?.[ib];
      return cell?.meters ?? Number.POSITIVE_INFINITY;
    };

    // ε is the direct knob from the request (clamped to the zod-validated
    // range as belt-and-braces). Decoupled from budget/minClusterSize so the
    // user can grow inclusion without juggling the trip-viability math —
    // the post-DBSCAN trim brings each cluster back inside the budget anyway.
    const epsilon = clamp(input.maxLinkMeters, 200, 5000);
    // Single-linkage on the ε-graph (DBSCAN with minPts = 2 = origin + one
    // walkable neighbor). A textbook density threshold like minPts = 8 would
    // miss path-following clusters: caches strung along a hiking trail are
    // linear, so no individual cache has 8 walkable caches within ε. By
    // requiring only pairwise reachability, any walkable chain forms a
    // cluster, and the post-filter below enforces the user's size floor.
    const minPts = 2;
    const { clusters: rawClusters } = dbscanFromDistances(
      pool.length,
      walkingMeters,
      epsilon,
      minPts,
    );

    // Budget-aware SPLIT (not trim): a single-linkage component can grow
    // arbitrarily long (chain of caches each within ε of the next) and span
    // well beyond the user's distance budget. The earlier approach trimmed
    // peripherals until one budget-fitting subset survived — which threw
    // away dozens of caches that could have formed their *own* viable loops.
    //
    // Instead, for each connected component:
    //   - If MST × 2 ≤ budget AND |members| ≤ maxCaches → keep as one cluster.
    //   - Else cut the longest MST edge (= the "weakest link", typically a
    //     bridge / long detour between two sub-areas) and recurse on the
    //     two halves.
    // A 60-cache super-component spanning 30 km of dike thus becomes 4–5
    // separate clusters that each plan to a real walking loop.
    const clusters = rawClusters.flatMap((c) =>
      splitByMstCut(
        c,
        walkingMeters,
        input.distanceBudgetMeters,
        input.minClusterSize,
        input.maxCaches,
      ),
    );

    // Diagnostics — built whether or not any clusters survived, so the
    // "no candidates found, why?" debug path has data to look at.
    const acceptedIndexSets = clusters.map((c) => new Set(c));
    const components: Tours.ClusterComponent[] = rawClusters.map((c) => {
      const sortedIdx = c.slice().sort((a, b) => a - b);
      const compMst = mstLengthByDistance(sortedIdx.length, (i, j) =>
        walkingMeters(sortedIdx[i]!, sortedIdx[j]!),
      );
      // A pre-trim component is "accepted" if any post-trim cluster is a
      // subset of it (the trim may have shrunk it). Approximate by checking
      // that some accepted cluster shares at least one cacheId with this
      // component (DBSCAN components are disjoint, so this is tight).
      const accepted = acceptedIndexSets.some((s) =>
        sortedIdx.some((i) => s.has(i)),
      );
      return {
        cacheIds: sortedIdx.map((i) => pool[i]!.id),
        mstLengthMeters: round2(compMst),
        accepted,
      };
    });
    const cacheConnectivity: Tours.CacheConnectivity[] = pool.map((c, i) => {
      let best = Number.POSITIVE_INFINITY;
      for (let j = 0; j < pool.length; j += 1) {
        if (i === j) continue;
        const d = walkingMeters(i, j);
        if (Number.isFinite(d) && d < best) best = d;
      }
      return {
        cacheId: c.id,
        nearestWalkableMeters: Number.isFinite(best) ? round2(best) : null,
      };
    });
    const diagnostics: Tours.ClusterDiagnostics = {
      epsilonMeters: epsilon,
      poolSize: pool.length,
      components,
      cacheConnectivity,
    };

    if (clusters.length === 0) {
      this.logger.debug(
        `discoverClusters: DBSCAN found no clusters (epsilon=${epsilon}, minPts=${minPts}, n=${pool.length})`,
      );
      return { candidates: [], diagnostics };
    }

    const wDensity = input.softPreferences.clusterDensityWeight;
    const wBudget = input.softPreferences.loopCompactnessWeight;
    const wParking = 1; // hard-coded for MVP; can promote to PlanInput later

    const candidates: Tours.ClusterCandidate[] = clusters.map((indices) => {
      // Sort indices so clusterId is stable across runs.
      const sorted = indices.slice().sort((a, b) => a - b);
      const cluster = sorted.map((i) => pool[i]!);

      const mst = mstLengthByDistance(sorted.length, (i, j) =>
        walkingMeters(sorted[i]!, sorted[j]!),
      );
      const density = mst > 0 ? cluster.length / mst : 0;

      const parkingPresence = cluster.some((c) =>
        c.parkingPoints.some(
          (p) =>
            haversineMeters(
              [c.location.coordinates[0]!, c.location.coordinates[1]!],
              p,
            ) <= PARKING_PRESENCE_RADIUS_M,
        ),
      )
        ? 1
        : 0;

      const meanLng = mean(cluster.map((c) => c.location.coordinates[0]!));
      const meanLat = mean(cluster.map((c) => c.location.coordinates[1]!));

      // Gaussian penalty for clusters too short or too long for the budget;
      // peaks at 1 when MST length exactly matches the distance budget.
      const r = (mst - input.distanceBudgetMeters) / input.distanceBudgetMeters;
      const budgetFit = Math.exp(-(r * r));

      const breakdown: Record<string, number> = {
        clusterDensity: density * wDensity,
        parkingPresence: parkingPresence * wParking,
        budgetFit: budgetFit * wBudget,
      };

      const targetScore = targetPreferenceScore(
        cluster,
        input.softPreferences,
      );
      Object.assign(breakdown, targetScore);

      const score = sum(Object.values(breakdown));

      return {
        clusterId: stableClusterId(cluster.map((c) => c.id)),
        cacheIds: cluster.map((c) => c.id),
        centroid: {
          type: "Point",
          coordinates: [meanLng, meanLat],
        },
        mstLengthMeters: round2(mst),
        score: round4(score),
        scoreBreakdown: Object.fromEntries(
          Object.entries(breakdown).map(([k, v]) => [k, round4(v)]),
        ),
      } satisfies Tours.ClusterCandidate;
    });

    // Sort by score desc; deterministic tie-break on clusterId.
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0;
    });

    return {
      candidates: candidates.slice(0, TOP_N_CLUSTERS),
      diagnostics,
    };
  }

  // ─── Pass 2: routed closed loop ───────────────────────────────────────────

  async planLoop(
    ownerId: string,
    input: Tours.PlanLoopInput,
  ): Promise<Tours.PlanResult> {
    const ids = Array.from(new Set(input.cacheIds))
      .sort((a, b) => a - b)
      .slice(0, MAX_LOOP_CACHES);

    const cacheRows = await this.caches.findByIds(ownerId, ids);
    if (cacheRows.length !== ids.length) {
      const missing = ids.filter((id) => !cacheRows.some((c) => c.id === id));
      throw new NotFoundException(
        `Caches not found for this user: ${missing.join(", ")}`,
      );
    }
    const byId = new Map(cacheRows.map((c) => [c.id, c]));

    // Walking OD matrix for the picked set. Cells are null when OSRM can't
    // connect a pair — we drop nodes whose connectivity is too poor before
    // running TSP.
    const matrix = await this.routing.getMatrix(ownerId, ids, PROFILE);
    const { connectedIds, distances } = filterConnected(ids, matrix);
    if (connectedIds.length < 2) {
      throw new NotFoundException(
        "Selected caches are not mutually reachable on foot — pick a different cluster.",
      );
    }

    // Pick parking BEFORE TSP so we can anchor the tour to the cache nearest
    // parking and avoid an awkward parking-far-from-start configuration.
    const parking = await this.pickParking(
      input,
      connectedIds.map((id) => byId.get(id)!),
    );

    const startIndex = nearestCacheIndexTo(
      connectedIds.map((id) => byId.get(id)!),
      parking.point.coordinates as [number, number],
    );

    const { order: tspOrder } = Tsp.solveTwoOpt(distances, startIndex);
    const orderedIds = tspOrder.map((i) => connectedIds[i]!);

    // Pull leg geometry for every adjacent cache pair in the open path. The
    // closed loop's closing leg (orderedIds[last] → orderedIds[0]) is
    // replaced by the two parking legs below.
    const interCacheLegs: Routing.Leg[] = [];
    for (let i = 0; i < orderedIds.length - 1; i += 1) {
      const leg = await this.routing.getLeg(
        ownerId,
        orderedIds[i]!,
        orderedIds[i + 1]!,
        PROFILE,
      );
      if (leg) interCacheLegs.push(leg);
    }

    const firstCoord = byId
      .get(orderedIds[0]!)!
      .location.coordinates as [number, number];
    const lastCoord = byId
      .get(orderedIds[orderedIds.length - 1]!)!
      .location.coordinates as [number, number];
    const parkingCoord = parking.point.coordinates as [number, number];

    const [parkingToFirst, lastToParking] = await Promise.all([
      this.osrm.route(parkingCoord, firstCoord, PROFILE),
      this.osrm.route(lastCoord, parkingCoord, PROFILE),
    ]);
    if (!parkingToFirst || !lastToParking) {
      throw new NotFoundException(
        "OSRM could not connect parking to the chosen loop — try a different start preference.",
      );
    }

    const polyline = concatLineStrings([
      parkingToFirst.geometry,
      ...interCacheLegs.map((l) => l.geometry),
      lastToParking.geometry,
    ]);

    const interMeters = sum(interCacheLegs.map((l) => l.meters));
    const interSeconds = sum(interCacheLegs.map((l) => l.seconds));
    const meters = parkingToFirst.meters + interMeters + lastToParking.meters;
    const seconds =
      parkingToFirst.seconds + interSeconds + lastToParking.seconds;
    const visitMinutes = input.timePerCacheMinutes * orderedIds.length;

    return {
      orderedCacheIds: orderedIds,
      polyline,
      totals: {
        meters: round2(meters),
        seconds: round2(seconds),
        visitMinutes,
      },
      parking,
      scoreBreakdown: {
        tspLoopMeters: round2(meters),
        parkingDetourMeters: round2(
          parkingToFirst.meters + lastToParking.meters,
        ),
        budgetSlackMeters: round2(input.distanceBudgetMeters - meters),
      },
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async pickParking(
    input: Tours.PlanLoopInput,
    cluster: readonly Caches.CacheDTO[],
  ): Promise<Tours.ParkingChoice> {
    const meanLng = mean(cluster.map((c) => c.location.coordinates[0]!));
    const meanLat = mean(cluster.map((c) => c.location.coordinates[1]!));
    const centroid: [number, number] = [meanLng, meanLat];

    switch (input.startPreference) {
      case "user-supplied-point": {
        if (!input.userSuppliedStart) {
          throw new NotFoundException(
            "startPreference=user-supplied-point requires userSuppliedStart",
          );
        }
        return {
          type: "user",
          point: { type: "Point", coordinates: input.userSuppliedStart },
          reason: "User-supplied start point",
        };
      }
      case "osrm-nearest-road": {
        // OSRM's /nearest endpoint isn't exposed by our client yet — fall back
        // to the cluster centroid. The planner can be upgraded later when
        // OsrmClient grows .nearest(); the user-facing reason is honest.
        return {
          type: "osrm-nearest",
          point: { type: "Point", coordinates: centroid },
          reason:
            "Cluster centroid (OSRM /nearest snapping arrives in a later milestone)",
        };
      }
      case "parking-waypoint":
      default: {
        const best = pickBestPqParking(cluster, centroid);
        if (best) {
          return {
            type: "pq",
            point: { type: "Point", coordinates: best },
            reason: "Cache-owner parking waypoint nearest the cluster centroid",
          };
        }
        return {
          type: "osrm-nearest",
          point: { type: "Point", coordinates: centroid },
          reason:
            "No PQ parking waypoint in the cluster — fell back to cluster centroid",
        };
      }
    }
  }
}

// ─── Pure utilities ─────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return sum(xs) / xs.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

interface MstEdge {
  from: number;
  to: number;
  weight: number;
}

/**
 * Build the MST as an edge list via Prim's algorithm. Distance is supplied
 * as a closure so callers can use Euclidean or walking metrics.
 *
 * Returns at most `n - 1` edges. If the graph is disconnected (some pairs
 * have +Infinity distance), the spanning tree only covers reachable nodes;
 * extra components are reported via the returned `coveredCount`.
 */
function buildMstEdges(
  n: number,
  dist: (i: number, j: number) => number,
): { edges: MstEdge[]; coveredCount: number } {
  if (n <= 1) return { edges: [], coveredCount: n };
  const inTree = new Array<boolean>(n).fill(false);
  const minDist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  const parent = new Array<number>(n).fill(-1);
  minDist[0] = 0;
  const edges: MstEdge[] = [];
  let covered = 0;
  for (let step = 0; step < n; step += 1) {
    let u = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j += 1) {
      if (!inTree[j] && minDist[j]! < best) {
        best = minDist[j]!;
        u = j;
      }
    }
    if (u < 0) break;
    inTree[u] = true;
    covered += 1;
    const p = parent[u]!;
    if (p >= 0 && Number.isFinite(best)) {
      edges.push({ from: p, to: u, weight: best });
    }
    for (let v = 0; v < n; v += 1) {
      if (inTree[v]) continue;
      const d = dist(u, v);
      if (d < (minDist[v] ?? Number.POSITIVE_INFINITY)) {
        minDist[v] = d;
        parent[v] = u;
      }
    }
  }
  return { edges, coveredCount: covered };
}

/**
 * Recursively split a connected component until every surviving sub-cluster
 * fits the user's size + budget constraints. At each step:
 *
 *   - If the component already fits → keep as one cluster.
 *   - Else cut the longest MST edge (the "weakest link" between two
 *     sub-areas — usually a long detour) and recurse on both halves.
 *   - Sub-pieces below `minSize` are discarded.
 *
 * Replaces the old "trim peripherals down to one cluster" approach, which
 * threw away dozens of caches from oversized components when those caches
 * could have formed their own viable loops.
 *
 * The MST × 2 budget check is a closed-tour upper bound (TSP ≤ 2·MST), so
 * any surviving cluster has a closed loop within the budget.
 */
function splitByMstCut(
  members: readonly number[],
  walkingDist: (a: number, b: number) => number,
  budgetMeters: number,
  minSize: number,
  maxSize: number,
  depth = 0,
): number[][] {
  if (members.length < minSize) return [];

  const localDist = (i: number, j: number): number =>
    walkingDist(members[i]!, members[j]!);
  const { edges } = buildMstEdges(members.length, localDist);
  const mst = edges.reduce((s, e) => s + e.weight, 0);

  const fitsSize = members.length <= maxSize;
  const fitsBudget = mst * 2 <= budgetMeters;
  if (fitsSize && fitsBudget) return [members.slice()];

  // Safety: bound recursion. With balanced cuts we hit depth ≈ log2(N), so
  // a cap of 64 is essentially unreachable; this guards against pathological
  // chains where every cut produces a tiny sub-piece.
  if (depth >= 64 || edges.length === 0) return [];

  // Cut the longest MST edge. Tie-break on (from, to) for determinism.
  let cutIdx = 0;
  for (let i = 1; i < edges.length; i += 1) {
    const a = edges[cutIdx]!;
    const b = edges[i]!;
    if (b.weight > a.weight) {
      cutIdx = i;
      continue;
    }
    if (b.weight === a.weight && (b.from < a.from || (b.from === a.from && b.to < a.to))) {
      cutIdx = i;
    }
  }
  const cut = edges[cutIdx]!;

  // BFS the remaining MST from `cut.from` to find one side; the rest is
  // the other side. The MST is a tree, so removing one edge produces
  // exactly two connected components.
  const adj = new Map<number, number[]>();
  for (let i = 0; i < edges.length; i += 1) {
    if (i === cutIdx) continue;
    const e = edges[i]!;
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }
  const leftSide = new Set<number>();
  const queue = [cut.from];
  leftSide.add(cut.from);
  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const v of adj.get(u) ?? []) {
      if (!leftSide.has(v)) {
        leftSide.add(v);
        queue.push(v);
      }
    }
  }

  const leftMembers: number[] = [];
  const rightMembers: number[] = [];
  for (let i = 0; i < members.length; i += 1) {
    if (leftSide.has(i)) leftMembers.push(members[i]!);
    else rightMembers.push(members[i]!);
  }

  return [
    ...splitByMstCut(leftMembers, walkingDist, budgetMeters, minSize, maxSize, depth + 1),
    ...splitByMstCut(rightMembers, walkingDist, budgetMeters, minSize, maxSize, depth + 1),
  ];
}

/**
 * MST length via Prim's algorithm, parameterised by a distance function so
 * the caller can supply either Euclidean or walking-distance metrics.
 *
 * Quadratic in N, fine here — N is capped at MAX_LOOP_CACHES = 50 for tours
 * and MAX_DISCOVERY_POOL = 300 for cluster scoring (matrix lookup is O(1)).
 * Used as the closed-tour lower bound: any TSP tour is ≤ 2 × MST.
 */
function mstLengthByDistance(
  n: number,
  dist: (i: number, j: number) => number,
): number {
  if (n <= 1) return 0;
  const inTree = new Array<boolean>(n).fill(false);
  const minDist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  minDist[0] = 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    let u = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j += 1) {
      if (!inTree[j] && minDist[j]! < best) {
        best = minDist[j]!;
        u = j;
      }
    }
    if (u < 0) break;
    inTree[u] = true;
    if (Number.isFinite(best)) total += best;
    for (let v = 0; v < n; v += 1) {
      if (inTree[v]) continue;
      const d = dist(u, v);
      if (d < (minDist[v] ?? Number.POSITIVE_INFINITY)) minDist[v] = d;
    }
  }
  return total;
}

function targetPreferenceScore(
  cluster: readonly Caches.CacheDTO[],
  prefs: Tours.SoftPreferences,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (prefs.terrainTarget) {
    const mean_ = mean(
      cluster.map((c) => c.terrain ?? prefs.terrainTarget!.value),
    );
    out.terrainMatch = gaussianMatch(
      mean_,
      prefs.terrainTarget.value,
      prefs.terrainTarget.tolerance,
      prefs.terrainTarget.weight,
    );
  }
  if (prefs.difficultyTarget) {
    const mean_ = mean(
      cluster.map((c) => c.difficulty ?? prefs.difficultyTarget!.value),
    );
    out.difficultyMatch = gaussianMatch(
      mean_,
      prefs.difficultyTarget.value,
      prefs.difficultyTarget.tolerance,
      prefs.difficultyTarget.weight,
    );
  }
  return out;
}

function gaussianMatch(
  observed: number,
  target: number,
  tolerance: number,
  weight: number,
): number {
  const z = (observed - target) / Math.max(tolerance, 1e-6);
  return weight * Math.exp(-(z * z));
}

function stableClusterId(cacheIds: readonly number[]): string {
  // Sorted-id hash so the same cluster keeps the same id across runs. Plain
  // FNV-1a — we only need a short stable string, not crypto.
  let h = 0x811c9dc5;
  for (const id of cacheIds) {
    let v = id;
    for (let b = 0; b < 4; b += 1) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      v >>>= 8;
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function pickBestPqParking(
  cluster: readonly Caches.CacheDTO[],
  centroid: readonly [number, number],
): [number, number] | null {
  let best: [number, number] | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  // Deterministic order: iterate caches by ascending id, parking points in
  // their original (insertion) order.
  const sorted = cluster.slice().sort((a, b) => a.id - b.id);
  for (const c of sorted) {
    for (const p of c.parkingPoints) {
      const d = haversineMeters(centroid, p);
      if (d < bestDist) {
        bestDist = d;
        best = [p[0], p[1]];
      }
    }
  }
  return best;
}

function nearestCacheIndexTo(
  cluster: readonly Caches.CacheDTO[],
  to: readonly [number, number],
): number {
  let bestI = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < cluster.length; i += 1) {
    const c = cluster[i]!;
    const d = haversineMeters(
      [c.location.coordinates[0]!, c.location.coordinates[1]!],
      to,
    );
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
}

function filterConnected(
  ids: readonly number[],
  matrix: Routing.Matrix,
): { connectedIds: number[]; distances: (number | null)[][] } {
  // Drop any cache that has zero reachable peers — it would force +Infinity
  // into the tour and produce a meaningless result.
  const keep: number[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    let reachable = 0;
    for (let j = 0; j < ids.length; j += 1) {
      if (i === j) continue;
      if (matrix.legs[i]?.[j]) reachable += 1;
    }
    if (reachable > 0) keep.push(i);
  }
  const connectedIds = keep.map((i) => ids[i]!);
  const distances = keep.map((i) =>
    keep.map((j) => (i === j ? 0 : (matrix.legs[i]?.[j]?.meters ?? null))),
  );
  return { connectedIds, distances };
}

function concatLineStrings(
  lines: readonly Geo.GeoJsonLineString[],
): Geo.GeoJsonLineString {
  const coords: [number, number][] = [];
  for (const line of lines) {
    for (let i = 0; i < line.coordinates.length; i += 1) {
      const c = line.coordinates[i]!;
      const last = coords[coords.length - 1];
      // Drop the joining duplicate where one leg's end equals the next leg's start.
      if (last && last[0] === c[0] && last[1] === c[1]) continue;
      coords.push([c[0], c[1]]);
    }
  }
  if (coords.length < 2) {
    // GeoJSON LineString needs ≥ 2 points; duplicate the lone point so the
    // schema validates rather than throwing on edge-case zero-length tours.
    const p = coords[0] ?? [0, 0];
    coords.push([p[0], p[1]]);
  }
  return { type: "LineString", coordinates: coords };
}
