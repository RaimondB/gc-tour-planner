// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Geo, Tsp, type Caches, type Walks } from "@gctp/shared";
import { visitMinutesFor } from "@gctp/shared/tours";
import { CachesService } from "../caches/caches.service.js";
import { CacheLanduseRepository } from "../caches/cache-landuse.repository.js";
import { LanduseProfilesRepository } from "../landuse-profiles/landuse-profiles.repository.js";
import { RoutingService } from "../routing/routing.service.js";
import { OSRM_CLIENT, type OsrmClient } from "../routing/osrm.client.js";
import { SavedToursRepository } from "../tours/saved-tours.repository.js";
import {
  COMPUTE_POOL,
  type ComputePool,
} from "../tours/compute/compute-pool.service.js";
import {
  cachePrize,
  insideReach,
  reachCircle,
  schedule,
  walkPace,
  type ScheduleLeg,
} from "./walk-plan.js";

const PROFILE = "foot" as const;
type LngLat = [number, number];

/**
 * Ad-hoc walk replanning (ADR-0040, FR-T18). Stateless: every call carries the
 * whole walk; nothing about the walk — least of all the position — is stored
 * or logged (ADR-0037 amendment).
 */
@Injectable()
export class WalksService {
  private readonly maxCandidates: number;
  private readonly hysteresisPct: number;

  constructor(
    private readonly caches: CachesService,
    private readonly cacheLanduse: CacheLanduseRepository,
    private readonly landuseProfiles: LanduseProfilesRepository,
    private readonly savedTours: SavedToursRepository,
    private readonly routing: RoutingService,
    @Inject(OSRM_CLIENT) private readonly osrm: OsrmClient,
    @Inject(COMPUTE_POOL) private readonly pool: ComputePool,
    config: ConfigService,
  ) {
    this.maxCandidates = positiveInt(config.get("WALK_MAX_CANDIDATES"), 60);
    this.hysteresisPct = positiveInt(config.get("WALK_HYSTERESIS_PCT"), 10);
  }

  async replan(
    ownerId: string,
    input: Walks.WalkReplanInput,
  ): Promise<Walks.WalkReplanResult> {
    const { profile } = input;
    const nowMs = Date.parse(input.now);
    const targetMs =
      Date.parse(input.deadline) - profile.budget.bufferMinutes * 60_000;
    const pace = walkPace(profile, input.calibration);
    const here = input.position as LngLat;
    const end = input.returnPoint as LngLat;
    const dwell = (c: Caches.CacheDTO): number =>
      visitMinutesFor(c, {
        timePerCacheMinutes: profile.time.visitMinutes,
        alStageVisitMinutes: profile.time.alStageVisitMinutes,
        toolBonusMinutes: profile.time.toolBonusMinutes,
        visitMinutesByType: profile.time.visitMinutesByType,
      }) *
      60 *
      pace.dwellFactor;

    // Locked next stop ("Go here next"): plan the rest from it.
    const locked = input.lockedNextId
      ? await this.lockedCache(ownerId, input.lockedNextId)
      : null;
    const lockedCoord = locked ? coordOf(locked) : null;
    const origin = lockedCoord ?? here;

    // S→E, S→L and L→E in one narrow table call.
    const pinned = await this.osrm.table(
      lockedCoord ? [here, end, lockedCoord] : [here, end],
      PROFILE,
      {
        sources: lockedCoord ? [0, 2] : [0],
        destinations: lockedCoord ? [1, 2] : [1],
      },
    );
    const hereToEndM = pinned[0]?.[0]?.meters ?? null;
    const minutesToReturn =
      hereToEndM === null ? 0 : (hereToEndM * pace.backSecondsPerMeter) / 60;
    const leadSeconds = locked
      ? (pinned[0]?.[1]?.meters ?? Number.POSITIVE_INFINITY) *
          pace.outSecondsPerMeter +
        dwell(locked)
      : 0;
    const originToEndM = locked ? (pinned[1]?.[0]?.meters ?? null) : hereToEndM;
    const budgetSeconds = (targetMs - nowMs) / 1000 - leadSeconds;
    const originToEndS =
      originToEndM === null
        ? Number.POSITIVE_INFINITY
        : originToEndM * pace.backSecondsPerMeter;

    // Nothing fits — not even the walk back (from the locked stop).
    if (!(originToEndS <= budgetSeconds)) {
      const lateByMinutes = locked
        ? Math.max(0, (originToEndS - budgetSeconds) / 60)
        : undefined;
      return this.respond({
        input,
        nowMs,
        targetMs,
        lead: locked
          ? {
              cache: locked,
              travel: leadSeconds - dwell(locked),
              visit: dwell(locked),
            }
          : undefined,
        stops: [],
        backSeconds: originToEndS,
        feasible: false,
        kept: "new",
        reason: locked
          ? "The chosen next cache doesn't leave time to get back."
          : "No time for caches: head back to your return point.",
        minutesToReturn,
        lateByMinutes,
        candidates: 0,
      });
    }

    // Candidate pool: profile filters, not found, not done on this walk, and
    // within reach of origin → E in the time left (walking only).
    const reachM = budgetSeconds / pace.outSecondsPerMeter;
    const done = new Set([
      ...input.visitedIds,
      ...input.skippedIds,
      ...input.dnfIds,
      ...(locked ? [locked.id] : []),
    ]);
    const pool = await this.candidatePool(
      ownerId,
      input,
      origin,
      end,
      reachM,
      done,
    );

    const kinds = await this.cacheLanduse.kindsByCacheId(pool.map((c) => c.id));
    const preferredLanduse = new Set(
      profile.objective.landuseProfileId
        ? ((
            await this.landuseProfiles.findById(
              ownerId,
              profile.objective.landuseProfileId,
            )
          )?.kinds ?? [])
        : [],
    );
    const ranked = pool
      .map((c) => ({
        cache: c,
        prize: cachePrize(
          c,
          kinds.get(c.id) ?? [],
          profile.objective,
          preferredLanduse,
        ),
        detour: detourMeters(origin, end, coordOf(c)),
      }))
      .sort(
        (a, b) =>
          b.prize - a.prize || a.detour - b.detour || a.cache.id - b.cache.id,
      )
      .slice(0, this.maxCandidates);
    const nodes = ranked.map((r) => r.cache);

    // Costs: cache ↔ cache from the warm route_legs; origin → caches and
    // caches → E from one narrow OSRM table each way.
    const ids = nodes.map((c) => c.id);
    const matrix =
      ids.length > 0
        ? await this.routing.getMatrix(ownerId, ids, PROFILE)
        : null;
    const idx = new Map(matrix?.cacheIds.map((id, i) => [id, i]) ?? []);
    const coords = nodes.map(coordOf);
    const [outRow, backCol] =
      nodes.length > 0
        ? await Promise.all([
            this.osrm.table([origin, ...coords], PROFILE, {
              sources: [0],
              destinations: coords.map((_, i) => i + 1),
            }),
            this.osrm.table([end, ...coords], PROFILE, {
              sources: coords.map((_, i) => i + 1),
              destinations: [0],
            }),
          ])
        : [[], []];

    const problem: Tsp.OrienteeringProblem = {
      nodes: ranked.map((r) => ({
        id: r.cache.id,
        prize: r.prize,
        visitSeconds: dwell(r.cache),
        type: r.cache.type,
        adventureId: r.cache.adventureId ?? null,
        stageSequence: r.cache.stageSequence ?? null,
        sequential: r.cache.adventureSequential ?? false,
      })),
      fromStart: nodes.map((_, i) =>
        toSeconds(outRow[0]?.[i]?.meters, pace.outSecondsPerMeter),
      ),
      toEnd: nodes.map((_, i) =>
        toSeconds(backCol[i]?.[0]?.meters, pace.backSecondsPerMeter),
      ),
      between: nodes.map((a) =>
        nodes.map((b) => {
          if (a.id === b.id) return 0;
          const cell = matrix?.legs[idx.get(a.id)!]?.[idx.get(b.id)!];
          return toSeconds(cell?.meters, pace.outSecondsPerMeter);
        }),
      ),
      startToEnd: originToEndS,
      budgetSeconds,
      keepTogether: profile.adventures.keepTogether,
      interleave: profile.adventures.interleave,
      varietyWeight: profile.objective.varietyWeight,
    };

    // Solve, seeded with the previous route; then the stability rule.
    const indexOf = new Map(nodes.map((c, i) => [c.id, i]));
    const previous = Tsp.repairPath(
      input.previousOrder
        .filter((id) => indexOf.has(id))
        .map((id) => indexOf.get(id)!),
      problem,
    );
    const fresh = await this.pool.solveOrienteering(problem, previous);
    const prevEval = Tsp.evaluatePath(previous, problem);
    const margin = Math.max(1, (this.hysteresisPct / 100) * prevEval.score);
    const keepPrevious =
      previous.length > 0 &&
      prevEval.feasible &&
      prevEval.valid &&
      fresh.score < prevEval.score + margin;
    const order = keepPrevious ? previous : fresh.order;
    const reason = keepPrevious
      ? "Kept your current route: the alternative wasn't clearly better."
      : previous.length > 0
        ? "Found a clearly better route."
        : "Planned a route.";

    const stops = order.map((i, k) => ({
      cache: nodes[i]!,
      travel:
        k === 0 ? problem.fromStart[i]! : problem.between[order[k - 1]!]![i]!,
      visit: problem.nodes[i]!.visitSeconds,
    }));
    const last = order.at(-1);
    return this.respond({
      input,
      nowMs,
      targetMs,
      lead: locked
        ? {
            cache: locked,
            travel: leadSeconds - dwell(locked),
            visit: dwell(locked),
          }
        : undefined,
      stops,
      backSeconds: last === undefined ? originToEndS : problem.toEnd[last]!,
      feasible: true,
      kept: keepPrevious ? "previous" : "new",
      reason,
      minutesToReturn,
      candidates: nodes.length,
    });
  }

  private async lockedCache(
    ownerId: string,
    id: number,
  ): Promise<Caches.CacheDTO> {
    const [cache] = await this.caches.findByIds(ownerId, [id]);
    if (!cache) throw new NotFoundException("That cache isn't one of yours.");
    return cache;
  }

  private async candidatePool(
    ownerId: string,
    input: Walks.WalkReplanInput,
    origin: LngLat,
    end: LngLat,
    reachM: number,
    done: ReadonlySet<number>,
  ): Promise<Caches.CacheDTO[]> {
    const { filters, adventures } = input.profile;
    const circle = reachCircle(origin, end, reachM);
    const excludeCacheIds = filters.excludeSavedTourCaches
      ? await this.savedTours.savedCacheIds(ownerId)
      : [];
    const { caches } = await this.caches.list(
      ownerId,
      {
        center: circle.center,
        radiusM: Math.min(50_000, Math.ceil(circle.radiusM)),
        types: filters.types.length > 0 ? filters.types : undefined,
        contexts: filters.contexts.length > 0 ? filters.contexts : undefined,
        excludeFound: true,
        includeDisabled: filters.includeDisabled,
        solvedMysteriesOnly: filters.solvedMysteriesOnly,
        multiSubtype:
          filters.multiSubtype === "all" ? undefined : filters.multiSubtype,
        hideToolCaches: filters.hideToolCaches,
        difficulty: filters.difficulty,
        terrain: filters.terrain,
      },
      { excludeCacheIds },
    );
    return caches.filter(
      (c) =>
        !done.has(c.id) &&
        (adventures.include || c.type !== "Adventure Lab") &&
        insideReach(origin, end, coordOf(c), reachM),
    );
  }

  /** Times, geometry and the response shape, for every outcome. */
  private async respond(args: {
    input: Walks.WalkReplanInput;
    nowMs: number;
    targetMs: number;
    lead?: { cache: Caches.CacheDTO; travel: number; visit: number };
    stops: { cache: Caches.CacheDTO; travel: number; visit: number }[];
    backSeconds: number;
    feasible: boolean;
    kept: "previous" | "new";
    reason: string;
    minutesToReturn: number;
    lateByMinutes?: number;
    candidates: number;
  }): Promise<Walks.WalkReplanResult> {
    const path = [...(args.lead ? [args.lead] : []), ...args.stops];
    const legs: ScheduleLeg[] = path.map((s) => ({
      cache: s.cache,
      travelSeconds: s.travel,
      visitSeconds: s.visit,
    }));
    const back = Number.isFinite(args.backSeconds) ? args.backSeconds : 0;
    const timeline = schedule(args.nowMs, legs, back);
    const here = args.input.position as LngLat;
    const end = args.input.returnPoint as LngLat;
    const waypoints: LngLat[] = [
      here,
      ...path.map((s) => coordOf(s.cache)),
      end,
    ];
    const [whole, next] = await Promise.all([
      this.osrm.routeMulti(waypoints, PROFILE),
      this.osrm.route(here, waypoints[1]!, PROFILE),
    ]);
    return {
      feasible: args.feasible,
      kept: args.kept,
      reason: args.reason,
      order: timeline.stops,
      returnAt: new Date(timeline.returnMs).toISOString(),
      leaveLastBy: new Date(args.targetMs - back * 1000).toISOString(),
      slackMinutes: round1((args.targetMs - timeline.returnMs) / 60_000),
      minutesToReturn: round1(args.minutesToReturn),
      ...(args.lateByMinutes !== undefined
        ? { lateByMinutes: round1(args.lateByMinutes) }
        : {}),
      geometry: (whole?.geometry as Geo.GeoJsonLineString | undefined) ?? null,
      nextLeg: next
        ? {
            geometry: next.geometry as Geo.GeoJsonLineString,
            meters: next.meters,
            seconds: next.seconds,
          }
        : null,
      candidates: args.candidates,
    };
  }
}

function coordOf(c: Caches.CacheDTO): LngLat {
  return [c.location.coordinates[0]!, c.location.coordinates[1]!];
}

/** Extra straight-line metres of going a → c → b instead of a → b. */
function detourMeters(a: LngLat, b: LngLat, c: LngLat): number {
  return (
    Geo.haversineMeters(a, c) +
    Geo.haversineMeters(c, b) -
    Geo.haversineMeters(a, b)
  );
}

function toSeconds(
  meters: number | undefined,
  secondsPerMeter: number,
): number | null {
  return meters === undefined ? null : meters * secondsPerMeter;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function positiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
