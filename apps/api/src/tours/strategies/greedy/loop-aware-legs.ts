// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Logger } from "@nestjs/common";
import type { Geo, Routing } from "@gctp/shared";
import type { OsrmLeg } from "../../../routing/osrm.client.js";

/**
 * Pass 2 builds a tour by stitching OSRM `/route` polylines between
 * consecutive caches. The TSP minimises Σ shortest(a→b), which is great for
 * total distance but doesn't know that two adjacent legs often share the
 * same street — leading to the classic "walk the main street twice"
 * retracing you see on dense village clusters.
 *
 * `pickLoopAwareLeg` greedily nudges each subsequent leg onto a different
 * polyline when OSRM offers one. It scores every alternative by
 *   meters + α × overlap_meters
 * against the polyline already accumulated for the tour. Overlap is measured
 * with a cheap fixed-cell spatial grid (default 25 m): coordinates from
 * earlier legs are hashed into grid keys; a candidate's coords contribute
 * to its overlap if they land in any populated key. Linear in total
 * coord count, no R-tree needed.
 *
 * The first leg has no accumulated polyline, so it's always the OSRM
 * primary. Each later leg picks the best-scoring alternative. When the
 * cheapest alternative still adds more than `maxDetourFraction` to the
 * primary's length, the picker falls back to primary — preferring distance
 * over loop-shape for cases like dead-end streets or single-bridge
 * crossings where there genuinely isn't a parallel path.
 */

export interface LoopAwarePickerOptions {
  /**
   * Weight on overlap in the score. α=1 means "one extra metre of detour is
   * worth one fewer metre of retraced street". Increase to fight retracing
   * harder, decrease to keep the tour shorter.
   */
  alpha: number;
  /**
   * Grid-cell size in meters. Coarser = faster + more lenient overlap
   * detection; finer = stricter but slower. 25 m matches the typical OSM
   * road-segment granularity for urban footpaths.
   */
  gridMeters: number;
  /**
   * Hard cap on how much longer than the primary a chosen alternative may
   * be. 0.5 means "alternatives that detour more than 50 % are rejected and
   * we fall back to primary". Stops the picker from forcing a useless loop
   * when no real alternative exists.
   */
  maxDetourFraction: number;
  /**
   * If the best `/route?alternatives` candidate still overlaps ≥ this
   * fraction of its coords with already-walked streets, try a via-waypoint
   * nudge: route through perpendicular-offset waypoints to force OSRM
   * onto a parallel street. 0 disables the fallback; 1 only triggers on
   * full retraces.
   */
  nudgeOverlapThreshold: number;
  /**
   * Perpendicular offset distances for the nudge via-point, in meters.
   * Multiple distances are tried (both sides each) so we cover a range of
   * urban geometries — ~80 m matches dense village blocks, ~160 m a
   * suburban grid. OSRM snaps each via to the nearest walkable node, so
   * "wrong" offsets just snap back to primary and cost nothing in score.
   */
  nudgeOffsetsMeters: readonly number[];
  /**
   * Fractional positions along A→B at which to anchor the via-waypoints.
   * `[0.5]` = midpoint only. `[0.33, 0.5, 0.67]` covers leg-start, middle,
   * leg-end. Combined with `nudgeOffsetsMeters` × 2 sides, this is the
   * total number of via-routing calls per high-overlap leg.
   */
  nudgeFractions: readonly number[];
  /**
   * When the primary's overlap fraction exceeds this threshold, the detour
   * cap is widened to `severeOverlapMaxDetourFraction` — the planner has
   * already established that the primary is retracing badly, so a longer
   * loop is worth considering. The score function still rejects truly
   * crazy detours via the α weight.
   */
  severeOverlapThreshold: number;
  /** Detour cap to use when severeOverlapThreshold is exceeded. */
  severeOverlapMaxDetourFraction: number;
}

export const DEFAULT_LOOP_PICKER_OPTIONS: LoopAwarePickerOptions = {
  alpha: 1.0,
  gridMeters: 25,
  maxDetourFraction: 0.5,
  nudgeOverlapThreshold: 0.3,
  // 80 m fits dense village blocks; 160 m a suburban grid. Cheap to try
  // both because OSRM snaps an off-road via back to the primary's road
  // for free.
  nudgeOffsetsMeters: [80, 160],
  // Midpoint-only by default. The full [0.33, 0.5, 0.67] sweep triples
  // the OSRM call count per nudge; turn it on per-deployment if the
  // midpoint isn't enough.
  nudgeFractions: [0.5],
  // 50 % overlap = "primary is mostly retracing"; relax the cap to the
  // severe fraction below so a meaningful loop has a chance to score.
  severeOverlapThreshold: 0.5,
  severeOverlapMaxDetourFraction: 1.5,
};

/**
 * Resolved loop-picker config + extra-alternatives count, read from env so
 * the heuristic is tunable per deployment without code changes:
 *
 *   PLANNER_LOOP_ALPHA            weight on overlap_m              (1.0)
 *   PLANNER_LOOP_GRID_M           grid-cell size in meters         (25)
 *   PLANNER_LOOP_MAX_DETOUR       max fraction longer than primary (0.5)
 *   PLANNER_LOOP_ALT_COUNT        extras requested beyond primary  (2,
 *                                 clamped 0..5)
 *   PLANNER_LOOP_NUDGE_THRESHOLD  overlap-fraction trigger for the
 *                                 via-waypoint fallback             (0.3)
 *   PLANNER_LOOP_NUDGE_OFFSET_M   perpendicular offset distance     (80)
 */
export interface ResolvedLoopOptions {
  picker: LoopAwarePickerOptions;
  /** Total alternatives to request (1 + extras). */
  altCount: number;
}

export function readLoopOptionsFromEnv(): ResolvedLoopOptions {
  const num = (env: string, fallback: number): number => {
    const raw = process.env[env];
    if (!raw) return fallback;
    const v = Number.parseFloat(raw);
    return Number.isFinite(v) ? v : fallback;
  };
  const csvNumbers = (env: string, fallback: readonly number[]): number[] => {
    const raw = process.env[env];
    if (!raw) return fallback.slice();
    const parsed = raw
      .split(",")
      .map((s) => Number.parseFloat(s.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);
    return parsed.length > 0 ? parsed : fallback.slice();
  };
  const picker: LoopAwarePickerOptions = {
    alpha: num("PLANNER_LOOP_ALPHA", DEFAULT_LOOP_PICKER_OPTIONS.alpha),
    gridMeters: num(
      "PLANNER_LOOP_GRID_M",
      DEFAULT_LOOP_PICKER_OPTIONS.gridMeters,
    ),
    maxDetourFraction: num(
      "PLANNER_LOOP_MAX_DETOUR",
      DEFAULT_LOOP_PICKER_OPTIONS.maxDetourFraction,
    ),
    nudgeOverlapThreshold: num(
      "PLANNER_LOOP_NUDGE_THRESHOLD",
      DEFAULT_LOOP_PICKER_OPTIONS.nudgeOverlapThreshold,
    ),
    nudgeOffsetsMeters: csvNumbers(
      "PLANNER_LOOP_NUDGE_OFFSETS_M",
      DEFAULT_LOOP_PICKER_OPTIONS.nudgeOffsetsMeters,
    ),
    nudgeFractions: csvNumbers(
      "PLANNER_LOOP_NUDGE_FRACTIONS",
      DEFAULT_LOOP_PICKER_OPTIONS.nudgeFractions,
    ),
    severeOverlapThreshold: num(
      "PLANNER_LOOP_SEVERE_OVERLAP",
      DEFAULT_LOOP_PICKER_OPTIONS.severeOverlapThreshold,
    ),
    severeOverlapMaxDetourFraction: num(
      "PLANNER_LOOP_SEVERE_MAX_DETOUR",
      DEFAULT_LOOP_PICKER_OPTIONS.severeOverlapMaxDetourFraction,
    ),
  };
  const extras = Math.max(
    0,
    Math.min(5, Math.floor(num("PLANNER_LOOP_ALT_COUNT", 2))),
  );
  return { picker, altCount: 1 + extras };
}

/**
 * Mutable grid of visited coordinates. Build once per tour; pass to every
 * `pickLoopAwareLeg` call so each new leg sees the cumulative overlap of
 * all earlier legs.
 */
export class OverlapGrid {
  private readonly cells = new Set<string>();
  private readonly gridMeters: number;
  // Origin for the equirectangular projection — set on the first point
  // added so every later (lng, lat) hashes relative to the same anchor.
  private originLng = 0;
  private originLat = 0;
  private originSet = false;
  // Cached cos(originLat) so the per-key cost is one multiply each axis.
  private cosOriginLat = 1;

  constructor(gridMeters: number) {
    this.gridMeters = gridMeters;
  }

  /** Hash a (lng, lat) into a grid cell key. */
  private key(lng: number, lat: number): string {
    // 1 deg lat ≈ 111_320 m; 1 deg lng ≈ 111_320 m × cos(lat). The cosine
    // reference is the origin's latitude — fine for the few-km span of a
    // single tour.
    const mLng = (lng - this.originLng) * 111_320 * this.cosOriginLat;
    const mLat = (lat - this.originLat) * 111_320;
    const ix = Math.round(mLng / this.gridMeters);
    const iy = Math.round(mLat / this.gridMeters);
    return `${ix}:${iy}`;
  }

  addLine(geometry: Geo.GeoJsonLineString): void {
    for (const [lng, lat] of geometry.coordinates) {
      if (!this.originSet) {
        this.originLng = lng;
        this.originLat = lat;
        this.cosOriginLat = Math.cos((lat * Math.PI) / 180);
        this.originSet = true;
      }
      this.cells.add(this.key(lng, lat));
    }
  }

  /**
   * Count how many coordinates of `geometry` fall in an already-populated
   * cell. Multiplied by the leg's mean inter-coord spacing approximates
   * "overlap meters". Coarse but cheap and good enough as a tie-breaker.
   */
  overlapHits(geometry: Geo.GeoJsonLineString): number {
    if (!this.originSet) return 0;
    let hits = 0;
    for (const [lng, lat] of geometry.coordinates) {
      if (this.cells.has(this.key(lng, lat))) hits += 1;
    }
    return hits;
  }
}

/**
 * Pick the best loop-aware alternative for one leg.
 *
 * Inputs:
 *  - `alternatives`: OSRM's primary plus any extras (≥ 1 entry).
 *  - `grid`: cumulative overlap state for the tour so far. NOT mutated by
 *    this function — caller mutates *after* the pick by calling
 *    `grid.addLine(picked.geometry)`. Keeps the function pure-by-input so
 *    it can be unit-tested without grid state leakage.
 *  - `options`: alpha / detour cap / grid size.
 *
 * Returns:
 *  - The picked leg + diagnostic info (score, overlap, score of primary,
 *    chosenIndex). Diagnostics let the planner log "leg N: picked alt 1 to
 *    avoid 320 m of retracing" so the user can see the heuristic working.
 */
export interface LoopAwarePick {
  picked: OsrmLeg;
  chosenIndex: number;
  overlapHits: number;
  score: number;
  primaryScore: number;
}

export function pickLoopAwareLeg(
  alternatives: readonly OsrmLeg[],
  grid: OverlapGrid,
  options: LoopAwarePickerOptions = DEFAULT_LOOP_PICKER_OPTIONS,
): LoopAwarePick | null {
  if (alternatives.length === 0) return null;
  const primary = alternatives[0]!;
  const primaryMeters = primary.meters;
  const maxAllowed = primaryMeters * (1 + options.maxDetourFraction);

  // Score every candidate. Convert grid hits to "overlap meters" by
  // multiplying by the candidate's mean inter-coord spacing — keeps α
  // dimensionless w.r.t. polyline density.
  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestHits = 0;
  let primaryScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < alternatives.length; i += 1) {
    const c = alternatives[i]!;
    const coords = c.geometry.coordinates.length;
    if (coords < 2) continue;
    const hits = grid.overlapHits(c.geometry);
    const meanSpacingM = c.meters / Math.max(1, coords - 1);
    const overlapMeters = hits * meanSpacingM;
    const score = c.meters + options.alpha * overlapMeters;
    if (i === 0) primaryScore = score;
    // Reject if the candidate is too long compared with primary.
    if (i > 0 && c.meters > maxAllowed) continue;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
      bestHits = hits;
    }
  }

  return {
    picked: alternatives[bestIndex]!,
    chosenIndex: bestIndex,
    overlapHits: bestHits,
    score: bestScore,
    primaryScore,
  };
}

/**
 * Compute via-waypoint candidates perpendicular to the straight line A→B
 * for the cross product of `fractions` × `offsetsMeters` × {+, −} sides.
 * Returns absolute (lng, lat) coords. Uses a flat equirectangular
 * projection — fine for the sub-km legs Pass 2 deals with.
 *
 * Why perpendicular: the goal is to nudge OSRM onto a *parallel* street.
 * OSRM snaps each via to its nearest walkable node, so if a parallel
 * street exists ~`offset` to the side, the route goes there; otherwise it
 * snaps back to the primary and the resulting polyline ≈ primary (cheap).
 *
 * Why multiple fractions: a 50 % midpoint may sit on the same main road
 * even though a 33 % or 67 % position is next to a parallel side-street.
 * Trying a few positions covers more local geometries.
 */
export function perpendicularViaCandidates(
  from: readonly [number, number],
  to: readonly [number, number],
  offsetsMeters: readonly number[],
  fractions: readonly number[] = [0.5],
): [number, number][] {
  if (offsetsMeters.length === 0 || fractions.length === 0) return [];
  const refLat = (from[1] + to[1]) / 2;
  const cosLat = Math.cos((refLat * Math.PI) / 180);
  // Convert to a local m-frame so the perpendicular is straightforward.
  const ax = from[0] * 111_320 * cosLat;
  const ay = from[1] * 111_320;
  const bx = to[0] * 111_320 * cosLat;
  const by = to[1] * 111_320;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return [];
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular unit vector (rotate 90°).
  const px = -uy;
  const py = ux;
  const toLngLat = (x: number, y: number): [number, number] => [
    x / (111_320 * cosLat),
    y / 111_320,
  ];
  const out: [number, number][] = [];
  for (const f of fractions) {
    if (!(f > 0 && f < 1)) continue;
    const cx = ax + dx * f;
    const cy = ay + dy * f;
    for (const off of offsetsMeters) {
      out.push(toLngLat(cx + px * off, cy + py * off));
      out.push(toLngLat(cx - px * off, cy - py * off));
    }
  }
  return out;
}

/**
 * Score a candidate leg against the overlap grid + the primary's length.
 * Returns the picker's `meters + α × overlap_meters` score, or `null` if
 * the candidate is over the detour cap.
 */
function scoreLeg(
  leg: OsrmLeg,
  primaryMeters: number,
  grid: OverlapGrid,
  opts: LoopAwarePickerOptions,
): { score: number; overlapHits: number; overlapMeters: number } | null {
  const coords = leg.geometry.coordinates.length;
  if (coords < 2) return null;
  const maxAllowed = primaryMeters * (1 + opts.maxDetourFraction);
  if (leg.meters > maxAllowed) return null;
  const hits = grid.overlapHits(leg.geometry);
  const meanSpacingM = leg.meters / Math.max(1, coords - 1);
  const overlapMeters = hits * meanSpacingM;
  return {
    score: leg.meters + opts.alpha * overlapMeters,
    overlapHits: hits,
    overlapMeters,
  };
}

/**
 * Helper for callers that just want the "fetch alternatives → pick best →
 * (optional via-waypoint nudge) → extend grid" loop, with logging.
 *
 * Returns `null` on disconnect, otherwise a `PickAndAccumulateResult`:
 *   - `picked`         — the leg that was scored best and added to the grid
 *   - `alternatives`   — every candidate considered (OSRM's primary + extras,
 *                        plus the picked via-nudge if a nudge won)
 *   - `selectedIndex`  — index of `picked` inside `alternatives`
 *
 * The caller uses `picked` for the polyline + totals (same shape as before)
 * and surfaces `alternatives` + `selectedIndex` in `PlanResult.legs[]` so
 * the manual-edit UI can offer leg-route swaps without a second OSRM round
 * trip.
 */
export interface PickAndAccumulateResult {
  picked: OsrmLeg;
  alternatives: OsrmLeg[];
  selectedIndex: number;
}

export async function pickAndAccumulate(args: {
  from: [number, number];
  to: [number, number];
  profile: Routing.RoutingProfile;
  count: number;
  fetchAlternatives: (
    from: [number, number],
    to: [number, number],
    profile: Routing.RoutingProfile,
    count: number,
  ) => Promise<OsrmLeg[]>;
  /** Optional via-waypoint router — enables the nudge fallback when OSRM's
   *  alternatives don't beat the overlap threshold. Both strategies pass
   *  `osrmClient.routeMulti` here. */
  fetchVia?: (
    coords: readonly [number, number][],
    profile: Routing.RoutingProfile,
  ) => Promise<OsrmLeg | null>;
  grid: OverlapGrid;
  options?: LoopAwarePickerOptions;
  logger?: Logger;
  label?: string;
}): Promise<PickAndAccumulateResult | null> {
  const opts = args.options ?? DEFAULT_LOOP_PICKER_OPTIONS;
  const alternatives = await args.fetchAlternatives(
    args.from,
    args.to,
    args.profile,
    args.count,
  );
  if (alternatives.length === 0) return null;
  const pick = pickLoopAwareLeg(alternatives, args.grid, opts);
  if (!pick) return null;
  const primary = alternatives[0]!;
  const label = args.label ?? "leg";

  // Decide whether to also try the via-waypoint nudge. The nudge is the
  // fix for the common case where OSRM's built-in alternatives produce
  // nothing useful (typical for short urban foot legs: 1 alt, primary
  // retraces a previously-walked street). We trigger when:
  //
  //   - a fetchVia is wired through,
  //   - the picked leg's overlap fraction exceeds nudgeOverlapThreshold,
  //   - the leg is long enough (>= 150 m) that there could plausibly be
  //     a parallel street to nudge onto,
  //   - and nudgeOverlapThreshold itself is < 1 (1 disables the nudge).
  let chosen = pick.picked;
  let chosenScore = pick.score;
  let chosenHits = pick.overlapHits;
  let chosenSource: "alt" | "nudge" = "alt";
  let nudgeAttempted = false;
  let nudgeCandidatesFetched = 0;

  const coordCount = pick.picked.geometry.coordinates.length;
  const overlapFraction = coordCount > 0 ? pick.overlapHits / coordCount : 0;
  // When the primary itself is retracing badly, the regular detour cap is
  // too strict — a 60 % longer loop with no overlap beats a 0 % longer
  // path that's fully on a walked street. Widen the cap, keep the score
  // honest.
  const nudgeOpts: LoopAwarePickerOptions =
    overlapFraction >= opts.severeOverlapThreshold
      ? {
          ...opts,
          maxDetourFraction: Math.max(
            opts.maxDetourFraction,
            opts.severeOverlapMaxDetourFraction,
          ),
        }
      : opts;
  if (
    args.fetchVia &&
    opts.nudgeOverlapThreshold < 1 &&
    overlapFraction >= opts.nudgeOverlapThreshold &&
    pick.picked.meters >= 150
  ) {
    nudgeAttempted = true;
    const viaCandidates = perpendicularViaCandidates(
      args.from,
      args.to,
      opts.nudgeOffsetsMeters,
      opts.nudgeFractions,
    );
    const nudgeFetches = await Promise.all(
      viaCandidates.map((via) =>
        args.fetchVia!([args.from, via, args.to], args.profile).catch(
          () => null,
        ),
      ),
    );
    nudgeCandidatesFetched = viaCandidates.length;
    for (const leg of nudgeFetches) {
      if (!leg) continue;
      // Use the widened cap for severe-overlap cases — `scoreLeg` rejects
      // anything above maxDetourFraction, and we want longer loops to be
      // considered when the primary is mostly retracing.
      const scored = scoreLeg(leg, primary.meters, args.grid, nudgeOpts);
      if (!scored) continue;
      if (scored.score < chosenScore) {
        chosen = leg;
        chosenScore = scored.score;
        chosenHits = scored.overlapHits;
        chosenSource = "nudge";
      }
    }
  }

  args.grid.addLine(chosen.geometry);

  // Build the surfaced alternative list. We filter out OSRM's
  // too-long detours (anything beyond the picker's `maxDetourFraction`
  // hard cap above primary) — the picker already refuses to *choose*
  // them, and exposing them as pickable in the UI would let the user
  // accidentally swap into a 2-3x-primary leg. Primary always stays
  // (index 0); the actually-chosen leg always stays (defensive, in
  // case picker policy changes); the via-nudge variant — if it won —
  // appends at the end so the UI can re-pick it without re-querying
  // OSRM. selectedIndex tracks `chosen` after the filter.
  const primaryMeters = primary.meters;
  const maxAllowed = primaryMeters * (1 + opts.maxDetourFraction);
  const acceptedAlternatives = alternatives.filter((alt, idx) => {
    if (idx === 0) return true;
    if (alt === chosen) return true;
    return alt.meters <= maxAllowed;
  });
  const surfacedAlternatives =
    chosenSource === "nudge"
      ? [...acceptedAlternatives, chosen]
      : acceptedAlternatives;
  const selectedIndex = surfacedAlternatives.indexOf(chosen);

  if (args.logger) {
    const nudgeNote = nudgeAttempted
      ? `; tried ${nudgeCandidatesFetched} via-nudge(s)`
      : "";
    if (chosenSource === "alt") {
      if (pick.chosenIndex > 0) {
        args.logger.debug(
          `${label}: got ${alternatives.length} alt(s); picked alt #${pick.chosenIndex} ` +
            `(${Math.round(chosen.meters)} m vs primary ${Math.round(primary.meters)} m, ` +
            `overlapHits=${chosenHits}${nudgeNote}${nudgeAttempted ? ", no improvement" : ""})`,
        );
      } else {
        args.logger.debug(
          `${label}: got ${alternatives.length} alt(s); kept primary ` +
            `(${Math.round(primary.meters)} m, overlapHits=${chosenHits}` +
            `${nudgeNote}${nudgeAttempted ? ", no improvement" : ""})`,
        );
      }
    } else {
      args.logger.debug(
        `${label}: got ${alternatives.length} alt(s); used via-waypoint nudge ` +
          `(${Math.round(chosen.meters)} m vs primary ${Math.round(primary.meters)} m, ` +
          `overlapHits=${chosenHits}${nudgeNote})`,
      );
    }
  }
  return {
    picked: chosen,
    alternatives: surfacedAlternatives,
    selectedIndex,
  };
}
