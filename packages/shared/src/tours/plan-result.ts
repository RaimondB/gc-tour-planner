// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonLineString, GeoJsonPoint } from "../geo/index.js";

export const ParkingChoice = z.object({
  type: z.enum(["pq", "osrm-nearest", "user", "osm"]),
  point: GeoJsonPoint,
  reason: z.string(),
  /**
   * True when no feasible parking was found within `maxLinkMeters` and the
   * planner fell back to the cluster centroid (Auto exhausted every source, or
   * an explicit single mode found nothing reachable). The UI renders a distinct
   * "no parking found here" marker. Defaults false so successful picks render
   * normally.
   */
  fallback: z.boolean().default(false),
  /**
   * When `type === "osm"`, identifies the source feature in
   * `parking_facilities`. Lets the UI link the picked parking back to its
   * map polygon and surface attributes (fee, access, capacity).
   */
  osm: z
    .object({
      osmId: z.number().int(),
      // osm2pgsql flex stores uppercase: N (node), W (way), R (relation).
      osmType: z.enum(["N", "W", "R"]),
      access: z.string().nullable(),
      fee: z.string().nullable(),
      name: z.string().nullable(),
    })
    .optional(),
});
export type ParkingChoice = z.infer<typeof ParkingChoice>;

export const PlanTotals = z.object({
  meters: z.number().finite().nonnegative(),
  seconds: z.number().finite().nonnegative(),
  visitMinutes: z.number().finite().nonnegative(),
});
export type PlanTotals = z.infer<typeof PlanTotals>;

/**
 * One OSRM route candidate considered by the loop-aware leg picker for a
 * single leg of the tour. The picker requests `1 + PLANNER_LOOP_ALT_COUNT`
 * (default 3) candidates per leg via `osrm.routeAlternatives`; before this
 * type existed the unpicked ones were discarded.
 *
 * Surfaced now so the UI can offer a "manual leg swap" affordance — click
 * a leg, see the alternatives the picker scored, pick a different one.
 * Each candidate carries enough state to render itself + to be picked
 * in place of the picker's selection without another OSRM round trip.
 */
export const PlanLegAlternative = z.object({
  meters: z.number().finite().nonnegative(),
  seconds: z.number().finite().nonnegative(),
  geometry: GeoJsonLineString,
});
export type PlanLegAlternative = z.infer<typeof PlanLegAlternative>;

/**
 * One leg of the planned closed loop, exposed for the manual edit-mode
 * UI. Legs are ordered: index 0 is parking→firstCache, indices
 * 1..(n-2) are cache→cache, index n-1 is lastCache→parking. The
 * parking endpoints use the sentinel `fromCacheId = 0` / `toCacheId = 0`
 * so the schema stays uniform.
 *
 * `alternatives` always includes the picked leg at
 * `selectedAlternativeIndex`. When no extras existed (OSRM only returned
 * the primary) the array has length 1 — the UI then shows "no
 * alternatives" for that leg.
 */
export const PlanLeg = z.object({
  index: z.number().int().nonnegative(),
  /** 0 = parking endpoint, otherwise a cache id from `orderedCacheIds`. */
  fromCacheId: z.number().int().nonnegative(),
  toCacheId: z.number().int().nonnegative(),
  meters: z.number().finite().nonnegative(),
  seconds: z.number().finite().nonnegative(),
  geometry: GeoJsonLineString,
  alternatives: z.array(PlanLegAlternative).min(1),
  selectedAlternativeIndex: z.number().int().nonnegative(),
});
export type PlanLeg = z.infer<typeof PlanLeg>;

/**
 * Why a cache that was in the planning candidate set isn't in the routed loop.
 * Surfaced per-cache so the UI can answer "why was this removed?" on click.
 *
 *  - `budget`               — over the distance budget, or (solver) the solver
 *                             chose not to visit it in the count-vs-length
 *                             trade-off. Carries `neededBudgetMeters`.
 *  - `outlier`              — behind-barrier detour dropped even within budget
 *                             (marginal-trim outlier floor). Carries the marginal.
 *  - `fringe`               — out-and-back spur the route already passes
 *                             (greedy post-leg-pick overlap trim).
 *  - `unreachable`          — couldn't be linked into the loop on foot within
 *                             `maxLinkMeters`: either no foot route at all, or one
 *                             only longer than the link cap. Sources: cohesion
 *                             gate (FR-T13), greedy/solver connected-component
 *                             filter, solver sentinel parking legs. UI copy must
 *                             not claim "no route exists" — a longer route may.
 *  - `adventure-incomplete` — solver AL-aware orphan trim: dropped to keep an
 *                             Adventure Lab whole (FR-I16).
 *  - `candidate-cap`        — a whole adventure / trailing cache cut BEFORE
 *                             planning because the candidate set hit its cap
 *                             (`AUGMENT_MAX_CACHES` / `MAX_LOOP_CACHES`).
 */
export const DropReason = z.enum([
  "budget",
  "outlier",
  "fringe",
  "unreachable",
  "adventure-incomplete",
  "candidate-cap",
]);
export type DropReason = z.infer<typeof DropReason>;

export const DroppedCache = z.object({
  id: z.number().int().positive(),
  reason: DropReason,
  /**
   * For `budget`/`outlier`: the extra walking metres this cache adds to the
   * loop. Lets the UI suggest "raise your budget by ~X to keep it". Absent for
   * reasons where a budget bump wouldn't help (unreachable, candidate-cap, …).
   */
  neededBudgetMeters: z.number().finite().nonnegative().optional(),
});
export type DroppedCache = z.infer<typeof DroppedCache>;

export const PlanResult = z.object({
  orderedCacheIds: z.array(z.number().int().positive()),
  /**
   * Cache ids the planner dropped from the input cluster because each one
   * added more walking distance to the tour than it was worth (see the
   * marginal-cost trim in apps/api/src/tours/strategies/greedy/marginal-trim.ts).
   * Empty when no cache was trimmed. Surfaced so the UI can show "skipped
   * for tour quality" alongside the routed loop, rather than silently
   * shrinking the cluster.
   *
   * Kept as a flat id list for back-compat (persisted in `StoredPlan` JSONB,
   * read by `summarizeAdventureCompletion` and the dropped-marker source).
   * The structured per-cache reasons live in `droppedCaches`; the two stay in
   * lock-step (`droppedCacheIds === droppedCaches.map(d => d.id)`).
   */
  droppedCacheIds: z.array(z.number().int().positive()).default([]),
  /**
   * Per-cache drop reasons (FR — "why was this removed?"). Additive over
   * `droppedCacheIds`; `.default([])` so old persisted plans keep parsing.
   */
  droppedCaches: z.array(DroppedCache).default([]),
  polyline: GeoJsonLineString,
  totals: PlanTotals,
  parking: ParkingChoice,
  scoreBreakdown: z.record(z.string(), z.number().finite()),
  /**
   * Per-leg breakdown with the alternatives OSRM offered for each pair.
   * Default `[]` for back-compat with strategies that don't populate it
   * (e.g. the solver path, which delegates Pass 2 to a sidecar that
   * doesn't surface alternatives). The aggregated `polyline` above is
   * still the source of truth for non-edit-mode rendering.
   */
  legs: z.array(PlanLeg).default([]),
  /**
   * Human "place" label for the tour — the nearest town / named park resolved
   * server-side from OSM (ADR-0036), e.g. "Wageningen" or "Bospark". Drives a
   * recognisable default tour name + GPX filename. Absent when nothing resolves
   * (or for plans made before this existed); the client falls back to the
   * parking name, then distance + cache count.
   */
  placeLabel: z.string().optional(),
});
export type PlanResult = z.infer<typeof PlanResult>;
