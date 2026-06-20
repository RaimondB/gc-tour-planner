// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Caches, Geo, Routing, Tours } from "@gctp/shared";
import { Tsp } from "@gctp/shared";
import { hasToolRequirement } from "@gctp/shared/caches";
import { CachesService } from "../../../caches/caches.service.js";
import { RoutingService } from "../../../routing/routing.service.js";
import {
  OSRM_CLIENT,
  type OsrmClient,
  type OsrmLeg,
} from "../../../routing/osrm.client.js";
import { ParkingFacilitiesRepository } from "../../../osm/parking-facilities.repository.js";
import { GreedyTspPlanner } from "../greedy/greedy-tsp-planner.js";
import { pickOsmParking } from "../pick-osm-parking.js";
import { pickBestPqParking } from "../pick-pq-parking.js";
import { largestConnectedComponent } from "../../adventure-cohesion.js";
import { collapseColocated } from "../greedy/colocate.js";
import { expandColocatedRoute } from "../greedy/expand-colocated.js";
import {
  OverlapGrid,
  pickAndAccumulate,
  readLoopOptionsFromEnv,
} from "../greedy/loop-aware-legs.js";
import {
  closedLoopMeters,
  resolveMarginalTrimConfig,
  trimMarginalCaches,
} from "../greedy/marginal-trim.js";
import {
  SOLVER_CLIENT,
  type SolverClient,
  type SolverPlanRequest,
} from "./solver-client.js";

const PROFILE: Routing.RoutingProfile = "foot";
const MAX_LOOP_CACHES = 50;

/** Default walking-metre radius for collapsing co-located stops
 *  (`PLANNER_COLOCATE_M`). Mirrors GreedyTspPlanner — kept in sync so both
 *  planners collapse AL stages identically. */
const DEFAULT_COLOCATE_M = 40;

/** Soft loop-length weight sent to the solver (`PLANNER_SOLVER_LOOP_WEIGHT`).
 *  Per-metre SOFT penalty; the visited-count reward lives on the MEDIUM level
 *  so this only compacts the loop among equal-count solutions. */
const DEFAULT_SOLVER_LOOP_WEIGHT = 1;

function colocateThresholdMeters(): number {
  const raw = process.env.PLANNER_COLOCATE_M;
  if (raw === undefined || raw.trim() === "") return DEFAULT_COLOCATE_M;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COLOCATE_M;
}

function solverLoopWeight(): number {
  const raw = process.env.PLANNER_SOLVER_LOOP_WEIGHT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SOLVER_LOOP_WEIGHT;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SOLVER_LOOP_WEIGHT;
}

/** Routing.Leg plus the alternatives the picker considered + the selected one,
 *  so the solver path can surface them in PlanResult.legs (manual-edit UI) and
 *  feed {@link expandColocatedRoute}, which requires ≥1 alternative per leg. */
type LegWithAlternatives = Routing.Leg & {
  alternatives: OsrmLeg[];
  selectedIndex: number;
};

/**
 * Solver-backed implementation of {@link Tours.TourPlannerStrategy}.
 *
 * **MVP boundary (intentional):** Pass 1 (cluster discovery) is delegated to
 * `GreedyTspPlanner` by composition. Only Pass 2 is solved by Timefold. The
 * follow-up wave will move cluster discovery behind a richer constraint
 * model — but discovery already runs on cheap aggregates (MST length, density,
 * parking presence), so there is no scoring lever the greedy version is
 * missing today. Pass 2 is where soft preferences (terrain, landuse, pace)
 * actually bite, which is why it's where Timefold lives first.
 *
 * Nest still owns:
 *   - OSRM matrix + per-leg geometry fetching
 *   - parking selection (reuses the same algorithm as greedy)
 *   - polyline stitching + ParkingChoice + scoreBreakdown construction
 *
 * The solver gets only what it needs: a precomputed numeric problem and a
 * weights object. It returns only orderedCacheIds + totals; Nest reassembles
 * the full PlanResult.
 */
@Injectable()
export class SolverTourPlanner implements Tours.TourPlannerStrategy {
  private readonly logger = new Logger(SolverTourPlanner.name);

  constructor(
    private readonly greedy: GreedyTspPlanner,
    private readonly caches: CachesService,
    private readonly routing: RoutingService,
    @Inject(OSRM_CLIENT) private readonly osrm: OsrmClient,
    @Inject(SOLVER_CLIENT) private readonly solver: SolverClient,
    private readonly parkingFacilities: ParkingFacilitiesRepository,
  ) {}

  // ─── Pass 1: delegated to greedy ──────────────────────────────────────────

  discoverClusters(
    ownerId: string,
    input: Tours.PlanInput,
  ): Promise<Tours.DiscoverClustersResult> {
    return this.greedy.discoverClusters(ownerId, input);
  }

  // ─── Pass 2: matrix → solver → geometry stitch ────────────────────────────

  async planLoop(
    ownerId: string,
    input: Tours.PlanLoopInput,
  ): Promise<Tours.PlanResult> {
    const dedupedIds = Array.from(new Set(input.cacheIds)).sort(
      (a, b) => a - b,
    );
    const allIds = dedupedIds.slice(0, MAX_LOOP_CACHES);
    // Candidates trimmed by the loop-size cap never reach the solver; surface
    // them as `candidate-cap` so they're not silently absent.
    const capTruncatedIds = dedupedIds.slice(MAX_LOOP_CACHES);

    const allRows = await this.caches.findByIds(ownerId, allIds);
    if (allRows.length !== allIds.length) {
      const missing = allIds.filter((id) => !allRows.some((c) => c.id === id));
      throw new NotFoundException(
        `Caches not found for this user: ${missing.join(", ")}`,
      );
    }

    // OD matrix (one OSRM /table call).
    const matrix = await this.routing.getMatrix(ownerId, allIds, PROFILE);
    const metersFull = matrix.legs.map((row) =>
      row.map((cell) => (cell ? cell.meters : null)),
    );
    const secondsFull = matrix.legs.map((row) =>
      row.map((cell) => (cell ? cell.seconds : null)),
    );

    // Connected-component pre-filter: keep the largest walk-connected component
    // so the solver never receives a set it can't route into one foot loop. A
    // disconnected minority (across a barrier) would otherwise force a `null`
    // leg → ∞ tour length → runaway over-trim. The minority drops as
    // `unreachable` (FR-T13). Replaces the old "≥2 reachable" guard.
    const { keptIds: ids, droppedIds: componentDropIds } =
      largestConnectedComponent(allIds, metersFull, input.maxLinkMeters);
    if (ids.length < 2) {
      throw new NotFoundException(
        "Selected caches are not mutually reachable on foot — pick a different cluster.",
      );
    }
    if (componentDropIds.length > 0) {
      this.logger.debug(
        `connected-component filter: dropped ${componentDropIds.length} cache(s) not linked to the main component (maxLink=${input.maxLinkMeters} m)`,
      );
    }

    const cacheRows = allRows.filter((c) => ids.includes(c.id));
    const byId = new Map(cacheRows.map((c) => [c.id, c]));
    // Re-slice the matrices down to the kept component (indexed like `ids`).
    const allIdsIndex = new Map(allIds.map((id, i) => [id, i]));
    const keptIdxs = ids.map((id) => allIdsIndex.get(id)!);
    const metersMatrix = keptIdxs.map((ri) =>
      keptIdxs.map((ci) => metersFull[ri]?.[ci] ?? null),
    );
    const secondsMatrix = keptIdxs.map((ri) =>
      keptIdxs.map((ci) => secondsFull[ri]?.[ci] ?? null),
    );

    // Collapse caches within a few metres' walk of each other into one routing
    // node — most importantly the co-located stages of an Adventure Lab. The
    // solver then plans on the (often far fewer) representatives; members are
    // expanded back on output. Without this, AL plans regress to near-zero-leg
    // weirdness and the atomicity/contiguity constraints fire on duplicate
    // single-spot nodes. Falls back to no-collapse if everything would merge
    // into one group (need ≥2 to loop).
    const colo = collapseColocated(
      ids,
      metersMatrix,
      (id) => byId.get(id)?.stageSequence ?? Number.POSITIVE_INFINITY,
      colocateThresholdMeters(),
    );
    const useCollapse = colo.repIds.length >= 2;
    const repIds = useCollapse ? colo.repIds : ids;
    const groupMembers: ReadonlyMap<number, number[]> = useCollapse
      ? colo.members
      : new Map(ids.map((id) => [id, [id]]));
    const membersOf = (repId: number): number[] =>
      groupMembers.get(repId) ?? [repId];

    // Reduce the meter/second matrices to representative-by-representative,
    // indexed like `repIds`. (collapseColocated only reduces meters, so we
    // derive both here from the rep positions for a consistent layout.)
    const idsIndex = new Map(ids.map((id, i) => [id, i]));
    const repOrigIdx = repIds.map((id) => idsIndex.get(id)!);
    const subMatrix = (m: (number | null)[][]): (number | null)[][] =>
      repOrigIdx.map((ri) =>
        repOrigIdx.map((rj) => (ri === rj ? 0 : (m[ri]?.[rj] ?? null))),
      );
    const repMatrixMeters = subMatrix(metersMatrix);
    const repMatrixSeconds = subMatrix(secondsMatrix);

    // Parking: same algorithm as greedy. Picked BEFORE the solver so the
    // anchor-to-parking legs go in as constants in the problem instance.
    const parking = await this.pickParking(input, cacheRows);
    const parkingCoord = parking.point.coordinates as [number, number];
    const coordOf = (id: number): [number, number] =>
      byId.get(id)!.location.coordinates as [number, number];

    // Parking → rep and rep → parking legs (length = #representatives).
    const parkingLegs = await Promise.all(
      repIds.map((id) => this.osrm.route(parkingCoord, coordOf(id), PROFILE)),
    );
    const closingLegs = await Promise.all(
      repIds.map((id) => this.osrm.route(coordOf(id), parkingCoord, PROFILE)),
    );

    // OSRM returns null for unreachable pairs; the solver needs concrete
    // numbers for the per-rep parking legs (otherwise it can't compute the
    // start/end totals). Force any unreachable rep to look extremely
    // expensive so the solver naturally drops it from the visit order.
    const PARK_UNREACHABLE_SENTINEL = 1e9;
    const parkingToCacheMeters = parkingLegs.map(
      (l) => l?.meters ?? PARK_UNREACHABLE_SENTINEL,
    );
    const parkingToCacheSeconds = parkingLegs.map(
      (l) => l?.seconds ?? PARK_UNREACHABLE_SENTINEL,
    );
    const cacheToParkingMeters = closingLegs.map(
      (l) => l?.meters ?? PARK_UNREACHABLE_SENTINEL,
    );
    const cacheToParkingSeconds = closingLegs.map(
      (l) => l?.seconds ?? PARK_UNREACHABLE_SENTINEL,
    );

    const visitSecondsPerCache = input.timePerCacheMinutes * 60;
    const timeBudgetSeconds = input.timeBudgetMinutes
      ? input.timeBudgetMinutes * 60
      : null;

    const req: SolverPlanRequest = {
      caches: repIds.map((id) => {
        const c = byId.get(id)!;
        return {
          id,
          lng: c.location.coordinates[0]!,
          lat: c.location.coordinates[1]!,
          adventureId: c.adventureId ?? null,
          stageSequence: c.stageSequence ?? null,
        };
      }),
      matrixMeters: repMatrixMeters,
      matrixSeconds: repMatrixSeconds,
      parkingToCacheMeters,
      parkingToCacheSeconds,
      cacheToParkingMeters,
      cacheToParkingSeconds,
      distanceBudgetMeters: input.distanceBudgetMeters,
      timeBudgetSeconds,
      visitSecondsPerCache,
      completeAdventuresOnly: input.completeAdventuresOnly,
      adventureInterleave: input.adventureInterleave,
      weights: { visitedCount: 100, loopLength: solverLoopWeight() },
    };

    const response = await this.solver.plan(req);
    const solverOrderedIds = response.orderedCacheIds;
    if (solverOrderedIds.length === 0) {
      throw new NotFoundException(
        "Solver returned an empty tour — try a larger distance budget or a different cluster.",
      );
    }

    // Marginal-cost trim — same rationale as in GreedyTspPlanner. The
    // solver's loop-length objective is soft (it never sacrifices a cache),
    // so a behind-barrier outlier whose haversine looks reasonable can still
    // survive. We re-TSP locally on the surviving reps using the same rep
    // matrix the solver was scored on.
    const trimThreshold = input.maxLinkMeters;
    const trimCfg = resolveMarginalTrimConfig();
    // trimMarginalCaches is async (ADR-0014); the solver path uses its
    // synchronous fallback solve (its heavy work is the Timefold sidecar).
    const trim = await trimMarginalCaches({
      orderedIds: solverOrderedIds,
      originalIds: repIds,
      distances: repMatrixMeters,
      // Parking distances are already fetched per-rep (parkingLegs +
      // closingLegs), so endpoint trim is on — catches the
      // last-cache-stuck-behind-a-barrier case.
      parkingToCacheM: parkingToCacheMeters,
      cacheToParkingM: cacheToParkingMeters,
      thresholdMeters: trimThreshold,
      minRemaining: 2,
      // Budget-aware: route the full cluster, keep caches while the loop fits
      // the distance budget, trim only outliers / to fit budget.
      ...(trimCfg.budgetAware
        ? {
            budgetMeters: input.distanceBudgetMeters,
            outlierThresholdMeters: trimCfg.outlierFactor * trimThreshold,
          }
        : {}),
    });
    let orderedIds = trim.orderedIds;
    // Per-rep drop reasons; expanded to members + emitted as droppedCaches below.
    const repDrops: {
      id: number;
      reason: Tours.DropReason;
      neededBudgetMeters?: number;
    }[] = trim.drops.map((d) => ({
      id: d.id,
      reason: d.reason,
      // A null-leg drop has an infinite marginal; omit the hint rather than
      // emit Infinity (JSON-serialises to `null` → fails the wire schema).
      ...(Number.isFinite(d.marginalMeters)
        ? { neededBudgetMeters: round2(d.marginalMeters) }
        : {}),
    }));

    // AL-aware trim (FR-I16): the solver keeps adventures whole (hard
    // atomicity constraint), but the marginal trim above drops individual reps
    // and can orphan an adventure. When `completeAdventuresOnly`, drop the rest
    // of any adventure the trim left partial — never present a partial AL. (We
    // drop the survivors rather than restore the trimmed rep, since the trim
    // removed it for a budget/outlier reason; trimming reduces distance so it
    // stays feasible.)
    if (input.completeAdventuresOnly) {
      const advOf = (repId: number): string | null =>
        byId.get(repId)?.adventureId ?? null;
      // Reps per adventure in the SOLVED order (atomic by construction).
      const totalByAdv = new Map<string, number>();
      for (const r of solverOrderedIds) {
        const a = advOf(r);
        if (a) totalByAdv.set(a, (totalByAdv.get(a) ?? 0) + 1);
      }
      const keptByAdv = new Map<string, number[]>();
      for (const r of orderedIds) {
        const a = advOf(r);
        if (!a) continue;
        const arr = keptByAdv.get(a) ?? [];
        arr.push(r);
        keptByAdv.set(a, arr);
      }
      const orphanDrops = new Set<number>();
      for (const [a, kept] of keptByAdv) {
        const total = totalByAdv.get(a) ?? kept.length;
        if (kept.length < total) for (const r of kept) orphanDrops.add(r);
      }
      if (orphanDrops.size > 0) {
        const next = orderedIds.filter((r) => !orphanDrops.has(r));
        // Keep the loop viable (≥2 stops); otherwise leave the trim as-is.
        if (next.length >= 2) {
          orderedIds = next;
          for (const r of orphanDrops)
            repDrops.push({ id: r, reason: "adventure-incomplete" });
          this.logger.debug(
            `AL-aware trim: dropped ${orphanDrops.size} rep(s) to keep adventures whole`,
          );
        }
      }
    }

    if (repDrops.length > 0) {
      this.logger.debug(
        `marginal trim: dropped ${repDrops.length} rep(s) (~${Math.round(trim.savedMeters)} m saved, threshold=${Math.round(trimThreshold)} m): [${repDrops.map((d) => d.id).join(", ")}]`,
      );
    }

    // Solver-omitted reps: candidates the solver never put in its visit order
    // (count-vs-length trade-off, or forced out by a sentinel/unreachable leg)
    // are otherwise silently absent. Classify each: `unreachable` when its
    // parking legs were the sentinel or it has no finite matrix neighbour,
    // else `budget` (the solver chose not to visit it).
    {
      const repIndex = new Map(repIds.map((id, i) => [id, i]));
      const inOrder = new Set(orderedIds);
      const accounted = new Set(repDrops.map((d) => d.id));
      const solverPicked = new Set(solverOrderedIds);
      const hasFiniteNeighbour = (idx: number): boolean =>
        repMatrixMeters[idx]?.some(
          (v, j) => j !== idx && v != null && Number.isFinite(v),
        ) ?? false;
      for (const repId of repIds) {
        if (inOrder.has(repId) || accounted.has(repId)) continue;
        // Only reps the solver itself omitted reach here (trim drops are
        // already accounted). Defensive: skip anything still in the solved set.
        if (solverPicked.has(repId)) continue;
        const idx = repIndex.get(repId)!;
        const unreachable =
          parkingToCacheMeters[idx]! >= PARK_UNREACHABLE_SENTINEL ||
          cacheToParkingMeters[idx]! >= PARK_UNREACHABLE_SENTINEL ||
          !hasFiniteNeighbour(idx);
        repDrops.push({
          id: repId,
          reason: unreachable ? "unreachable" : "budget",
        });
      }
    }

    // Budget-fill re-add (FR-T13): the trim can leave the loop well under
    // budget — especially after dropping a whole spread adventure. Re-add whole
    // adventures (and individual non-AL reps) that were dropped for *budget*
    // reasons, cheapest-to-reach first, while the closed loop stays within
    // budget. `outlier`/`unreachable` drops are never reclaimed (genuine
    // barrier detours / no foot route). Re-2-opt per accepted unit; the
    // closed-loop length over the rep matrix gates each addition.
    {
      const repIndexF = new Map(repIds.map((id, i) => [id, i]));
      const distAt = (a: number, b: number): number => {
        const i = repIndexF.get(a);
        const j = repIndexF.get(b);
        if (i === undefined || j === undefined) return Number.POSITIVE_INFINITY;
        const v = repMatrixMeters[i]?.[j];
        return v == null ? Number.POSITIVE_INFINITY : v;
      };
      const parkTo = (id: number): number => {
        const i = repIndexF.get(id);
        const v = i === undefined ? undefined : parkingToCacheMeters[i];
        return v == null || v >= PARK_UNREACHABLE_SENTINEL
          ? Number.POSITIVE_INFINITY
          : v;
      };
      const toPark = (id: number): number => {
        const i = repIndexF.get(id);
        const v = i === undefined ? undefined : cacheToParkingMeters[i];
        return v == null || v >= PARK_UNREACHABLE_SENTINEL
          ? Number.POSITIVE_INFINITY
          : v;
      };
      const advOf = (id: number): string | null =>
        byId.get(id)?.adventureId ?? null;

      // Group dropped reps into atomic units (whole adventure, or one non-AL
      // rep). A unit is eligible only if every dropped rep in it is reclaimable.
      const dropReasonById = new Map(repDrops.map((d) => [d.id, d.reason]));
      const reclaimable = (r: Tours.DropReason): boolean =>
        r === "budget" || r === "adventure-incomplete";
      const unitOf = (id: number): string => {
        const a = advOf(id);
        return a ? `adv:${a}` : `cache:${id}`;
      };
      const unitMembers = new Map<string, number[]>();
      for (const d of repDrops) {
        const key = unitOf(d.id);
        (unitMembers.get(key) ?? unitMembers.set(key, []).get(key)!).push(d.id);
      }
      const eligibleUnits = [...unitMembers.values()].filter((members) =>
        members.every((id) => reclaimable(dropReasonById.get(id)!)),
      );

      let current = orderedIds.slice();
      const nearestToLoop = (members: readonly number[]): number =>
        Math.min(...members.flatMap((m) => current.map((c) => distAt(m, c))));
      eligibleUnits.sort((x, y) => nearestToLoop(x) - nearestToLoop(y));

      const reAdded = new Set<number>();
      for (const members of eligibleUnits) {
        const candidate = [...current, ...members];
        const subDist = candidate.map((a) =>
          candidate.map((b) => {
            const d = a === b ? 0 : distAt(a, b);
            return Number.isFinite(d) ? d : Number.MAX_SAFE_INTEGER;
          }),
        );
        const { order } = Tsp.solveTwoOpt(subDist, 0);
        const reordered = order.map((i) => candidate[i]!);
        if (
          closedLoopMeters(reordered, distAt, parkTo, toPark) <=
          input.distanceBudgetMeters
        ) {
          current = reordered;
          for (const id of members) reAdded.add(id);
        }
      }

      if (reAdded.size > 0) {
        orderedIds = current;
        for (let i = repDrops.length - 1; i >= 0; i -= 1) {
          if (reAdded.has(repDrops[i]!.id)) repDrops.splice(i, 1);
        }
        this.logger.debug(
          `budget re-add: restored ${reAdded.size} rep(s) within budget`,
        );
      }
    }

    // Loop-aware polyline assembly. The solver order is fixed, but each leg
    // gets a chance to pick a non-overlapping alternative against the polyline
    // accumulated so far (stops walking the same street twice). The picked
    // legs' meters/seconds feed back into totals, so the displayed totals match
    // the rendered polyline. Legs carry their alternatives so the manual-edit
    // UI works and {@link expandColocatedRoute} can splice co-located members.
    const loopOpts = readLoopOptionsFromEnv();
    const grid = new OverlapGrid(loopOpts.picker.gridMeters);
    const altCount = loopOpts.altCount;
    const firstCoord = coordOf(orderedIds[0]!);
    const lastCoord = coordOf(orderedIds[orderedIds.length - 1]!);

    const ptf = await pickAndAccumulate({
      from: parkingCoord,
      to: firstCoord,
      profile: PROFILE,
      count: altCount,
      fetchAlternatives: this.osrm.routeAlternatives.bind(this.osrm),
      grid,
      options: loopOpts.picker,
      logger: this.logger,
      label: "parking→first",
    });
    if (!ptf) {
      throw new NotFoundException(
        "OSRM could not connect parking to the chosen loop — try a different start preference.",
      );
    }
    const parkingToFirst: LegWithAlternatives = {
      fromCacheId: 0,
      toCacheId: orderedIds[0]!,
      profile: PROFILE,
      meters: ptf.picked.meters,
      seconds: ptf.picked.seconds,
      geometry: ptf.picked.geometry,
      alternatives: ptf.alternatives,
      selectedIndex: ptf.selectedIndex,
    };

    const interCacheLegs: LegWithAlternatives[] = [];
    for (let i = 0; i < orderedIds.length - 1; i += 1) {
      const fromId = orderedIds[i]!;
      const toId = orderedIds[i + 1]!;
      const picked = await pickAndAccumulate({
        from: coordOf(fromId),
        to: coordOf(toId),
        profile: PROFILE,
        count: altCount,
        fetchAlternatives: this.osrm.routeAlternatives.bind(this.osrm),
        fetchVia: this.osrm.routeMulti.bind(this.osrm),
        grid,
        options: loopOpts.picker,
        logger: this.logger,
        label: `leg ${i + 1}`,
      });
      if (picked) {
        interCacheLegs.push({
          fromCacheId: fromId,
          toCacheId: toId,
          profile: PROFILE,
          meters: picked.picked.meters,
          seconds: picked.picked.seconds,
          geometry: picked.picked.geometry,
          alternatives: picked.alternatives,
          selectedIndex: picked.selectedIndex,
        });
      }
    }

    const ltp = await pickAndAccumulate({
      from: lastCoord,
      to: parkingCoord,
      profile: PROFILE,
      count: altCount,
      fetchAlternatives: this.osrm.routeAlternatives.bind(this.osrm),
      grid,
      options: loopOpts.picker,
      logger: this.logger,
      label: "last→parking",
    });
    if (!ltp) {
      throw new NotFoundException(
        "OSRM could not connect parking to the chosen loop — try a different start preference.",
      );
    }
    const lastToParking: LegWithAlternatives = {
      fromCacheId: orderedIds[orderedIds.length - 1]!,
      toCacheId: 0,
      profile: PROFILE,
      meters: ltp.picked.meters,
      seconds: ltp.picked.seconds,
      geometry: ltp.picked.geometry,
      alternatives: ltp.alternatives,
      selectedIndex: ltp.selectedIndex,
    };

    // Expand co-located groups back to their member stops (the solver ran on
    // one rep per group). Each group becomes its members — contiguous, in visit
    // order — with the real OSRM legs between groups and tiny synthesized legs
    // between co-located members. Preserves `legs.length === orderedIds + 1` and
    // the ≥1-alternative invariant every PlanLeg requires.
    const { orderedIds: orderedIdsFinal, allLegs } = expandColocatedRoute(
      orderedIds,
      membersOf,
      coordOf,
      { parkingToFirst, interCacheLegs, lastToParking },
    );
    // Structured drop reasons (PlanResult.droppedCaches). A dropped
    // representative drops all of its members, each inheriting the rep's reason.
    // Cap-truncated ids never entered the rep set, so they're added directly.
    const droppedCaches: Tours.DroppedCache[] = [
      ...repDrops.flatMap((d) =>
        membersOf(d.id).map((id) => ({
          id,
          reason: d.reason,
          ...(d.neededBudgetMeters != null
            ? { neededBudgetMeters: d.neededBudgetMeters }
            : {}),
        })),
      ),
      ...capTruncatedIds.map((id) => ({
        id,
        reason: "candidate-cap" as const,
      })),
      ...componentDropIds.map((id) => ({
        id,
        reason: "unreachable" as const,
      })),
    ];
    const droppedExpanded = droppedCaches.map((d) => d.id);

    const polyline = concatLineStrings(allLegs.map((l) => l.geometry));
    const meters = sum(allLegs.map((l) => l.meters));
    const seconds = sum(allLegs.map((l) => l.seconds));
    const parkingDetourMeters =
      (allLegs[0]?.meters ?? 0) + (allLegs[allLegs.length - 1]?.meters ?? 0);

    // FR-SF7: each cache that needs a tool gets `toolBonusMinutes` on top of its
    // base visit time. Adventure Lab stages use their own (smaller) per-stage
    // visit time (`alStageVisitMinutes`) — labs are quick and often clustered.
    // Mirrors GreedyTspPlanner; only affects `totals.visitMinutes`.
    let toolStopCount = 0;
    let alStageCount = 0;
    for (const id of orderedIdsFinal) {
      const c = byId.get(id);
      if (!c) continue;
      if (c.type === "Adventure Lab") alStageCount += 1;
      if (hasToolRequirement(c.attributeIds, c.descriptionHints))
        toolStopCount += 1;
    }
    const regularStops = orderedIdsFinal.length - alStageCount;
    const visitMinutes =
      input.timePerCacheMinutes * regularStops +
      input.alStageVisitMinutes * alStageCount +
      input.toolBonusMinutes * toolStopCount;

    // Project the in-memory legs into the wire shape (parking endpoints use the
    // sentinel cache id 0). Each leg carries the alternatives the picker
    // considered; synthesized co-located legs carry their own single alternative.
    const legs: Tours.PlanLeg[] = allLegs.map((l, idx) => ({
      index: idx,
      fromCacheId: l.fromCacheId,
      toCacheId: l.toCacheId,
      meters: round2(l.meters),
      seconds: round2(l.seconds),
      geometry: l.geometry,
      alternatives: l.alternatives.map((a) => ({
        meters: round2(a.meters),
        seconds: round2(a.seconds),
        geometry: a.geometry,
      })),
      selectedAlternativeIndex: l.selectedIndex,
    }));

    return {
      orderedCacheIds: orderedIdsFinal,
      droppedCacheIds: droppedExpanded,
      droppedCaches,
      polyline,
      totals: {
        meters: round2(meters),
        seconds: round2(seconds),
        visitMinutes,
      },
      parking,
      scoreBreakdown: {
        solverTotalMeters: round2(response.totalMeters),
        solverTotalSeconds: round2(response.totalSeconds),
        tspLoopMeters: round2(meters),
        parkingDetourMeters: round2(parkingDetourMeters),
        budgetSlackMeters: round2(input.distanceBudgetMeters - meters),
        visitedCount: response.visitedCount,
        marginalTrimDroppedCount: droppedExpanded.length,
        // savedMeters can be Infinity when a null-leg cache was trimmed; keep the
        // wire numeric (Infinity → JSON null → fails PlanResult.parse).
        marginalTrimSavedMeters: Number.isFinite(trim.savedMeters)
          ? round2(trim.savedMeters)
          : 0,
      },
      legs,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Parking selection. Mirrors GreedyTspPlanner.pickParking — kept private
   * here rather than promoted to a shared helper to keep the MVP diff small;
   * a follow-up can extract once the parking algorithm grows OSRM /nearest
   * snapping or multi-candidate scoring.
   */
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
          reason: "Manually picked start point",
          fallback: false,
        };
      }
      case "osrm-nearest-road":
        // Snap centroid to a real road via OSRM /nearest — otherwise a
        // centroid in a river / field becomes a huge parking-to-first detour.
        // This is the intended result for the mode, so it isn't a fallback
        // unless /nearest finds nothing at all.
        return this.snapCentroid(centroid, { snapIsFallback: false });
      case "osm-parking": {
        const osm = await pickOsmParking(
          this.parkingFacilities,
          this.osrm,
          input,
          cluster,
          centroid,
        );
        return (
          osm ??
          this.centroidFallback(
            centroid,
            "No public parking within range — starting at cluster centroid",
          )
        );
      }
      case "auto": {
        // First feasible source wins. The solver has no car-road enumerate, so
        // Auto's third step is the OSRM-nearest snap (which always resolves to
        // some point); the fallback only trips if even /nearest finds nothing.
        const best = await this.tryPqParking(cluster);
        if (best) return best;
        const osm = await pickOsmParking(
          this.parkingFacilities,
          this.osrm,
          input,
          cluster,
          centroid,
        );
        if (osm) return osm;
        return this.snapCentroid(centroid, { snapIsFallback: true });
      }
      case "parking-waypoint":
      default: {
        const best = await this.tryPqParking(cluster);
        return (
          best ??
          this.centroidFallback(
            centroid,
            "No cache-owner parking near this cluster — starting at cluster centroid",
          )
        );
      }
    }
  }

  /** Cache-owner (PQ) parking with the shortest walk to a cluster cache.
   *  `null` when none is OSRM-routable. */
  private async tryPqParking(
    cluster: readonly Caches.CacheDTO[],
  ): Promise<Tours.ParkingChoice | null> {
    const best = await pickBestPqParking(cluster, this.osrm);
    if (!best) return null;
    return {
      type: "pq",
      point: { type: "Point", coordinates: best },
      reason:
        "Cache-owner parking waypoint with shortest walking route to a cluster cache",
      fallback: false,
    };
  }

  /** Snap the centroid to the nearest walkable road. Used both as the explicit
   *  osrm-nearest-road mode (where a successful snap is the intended result) and
   *  as Auto's last resort (where it always counts as a fallback). A raw
   *  centroid — when /nearest finds no road — is always a fallback. */
  private async snapCentroid(
    centroid: [number, number],
    opts: { snapIsFallback: boolean },
  ): Promise<Tours.ParkingChoice> {
    const snapped = await this.osrm.nearest(centroid, PROFILE);
    return {
      type: "osrm-nearest",
      point: { type: "Point", coordinates: snapped ?? centroid },
      reason: snapped
        ? "Cluster centroid snapped to nearest walkable road"
        : "OSRM /nearest found no walkable road — using raw cluster centroid",
      fallback: snapped ? opts.snapIsFallback : true,
    };
  }

  /** Centroid fallback used when no parking source yields a feasible start. */
  private centroidFallback(
    centroid: [number, number],
    reason: string,
  ): Tours.ParkingChoice {
    return {
      type: "osrm-nearest",
      point: { type: "Point", coordinates: centroid },
      reason,
      fallback: true,
    };
  }
}

// ─── Pure utilities (mirrored from greedy; intentionally not deduped yet) ───

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

function concatLineStrings(
  lines: readonly Geo.GeoJsonLineString[],
): Geo.GeoJsonLineString {
  const coords: [number, number][] = [];
  for (const line of lines) {
    for (let i = 0; i < line.coordinates.length; i += 1) {
      const c = line.coordinates[i]!;
      const last = coords[coords.length - 1];
      if (last && last[0] === c[0] && last[1] === c[1]) continue;
      coords.push([c[0], c[1]]);
    }
  }
  if (coords.length < 2) {
    const p = coords[0] ?? [0, 0];
    coords.push([p[0], p[1]]);
  }
  return { type: "LineString", coordinates: coords };
}
