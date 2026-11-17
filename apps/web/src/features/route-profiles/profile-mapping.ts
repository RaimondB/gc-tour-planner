// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { RouteProfileSettings } from "@gctp/shared/route-profiles";
import type { SearchParams } from "../../lib/search-params.js";
import type { PlanSettings } from "../planning/PlannerSidebar.js";

/**
 * Route profile ↔ planner settings (ADR-0039 §4). A profile holds every
 * planner setting except the search centre and the map-display toggles, so the
 * mapping is one-to-one: the planner edits a profile-shaped value through the
 * same form as the profile editor, and saving the planner state as a profile
 * loses nothing.
 */

export interface PlannerState {
  search: SearchParams;
  plan: PlanSettings;
}

/** Write every profile setting into the planner state; keep centre + display. */
export function applyRouteProfile(
  s: RouteProfileSettings,
  { search, plan }: PlannerState,
): PlannerState {
  return {
    search: {
      ...search,
      radiusM: s.search.radiusM,
      types: [...s.filters.types],
      multiSubtype: s.filters.multiSubtype,
      excludeFound: s.filters.excludeFound,
      includeDisabled: s.filters.includeDisabled,
      hideToolCaches: s.filters.hideToolCaches,
      solvedMysteriesOnly: s.filters.solvedMysteriesOnly,
      contexts: [...s.filters.contexts],
      difficulty: { ...s.filters.difficulty },
      terrain: { ...s.filters.terrain },
    },
    plan: {
      ...plan,
      excludeSavedTourCaches: s.filters.excludeSavedTourCaches,
      includeAdventuresInClustering: s.adventures.include,
      completeAdventuresOnly: s.adventures.keepTogether,
      adventureInterleave: s.adventures.interleave,
      landuseProfileId: s.objective.landuseProfileId ?? undefined,
      landuseWeight: s.objective.landuseWeight,
      centerProximityWeight: s.objective.centerProximityWeight,
      varietyWeight: s.objective.varietyWeight,
      preferredTypes: [...s.objective.preferredTypes],
      preferredTypeWeight: s.objective.preferredWeight,
      timePerCacheMinutes: s.time.visitMinutes,
      visitMinutesByType: { ...s.time.visitMinutesByType },
      alStageVisitMinutes: s.time.alStageVisitMinutes,
      toolBonusMinutes: s.time.toolBonusMinutes,
      avgWalkingKmh: s.time.walkingKmh,
      distanceBudgetMeters: s.budget.distanceBudgetMeters,
      durationMinutes: s.budget.durationMinutes,
      bufferMinutes: s.budget.bufferMinutes,
      startPreference: s.parking.startPreference,
      osmParkingAccessFilter: [...s.parking.osmAccess],
      osmParkingFeeFilter: s.parking.osmFee,
      minClusterSize: s.advanced.minClusterSize,
      maxLinkMeters: s.advanced.maxLinkMeters,
      clusteringStrategy: s.advanced.clusteringStrategy,
      topNClusters: s.advanced.topNClusters,
      fringeTrimMeters: s.advanced.fringeTrimMeters,
    },
  };
}

/** The profile-shaped view of the planner state (inverse of applyRouteProfile). */
export function profileFromPlanner({
  search,
  plan,
}: PlannerState): RouteProfileSettings {
  return RouteProfileSettings.parse({
    search: { radiusM: search.radiusM },
    filters: {
      types: [...search.types],
      multiSubtype: search.multiSubtype,
      excludeFound: search.excludeFound,
      includeDisabled: search.includeDisabled,
      hideToolCaches: search.hideToolCaches,
      solvedMysteriesOnly: search.solvedMysteriesOnly,
      contexts: [...search.contexts],
      difficulty: { ...search.difficulty },
      terrain: { ...search.terrain },
      excludeSavedTourCaches: plan.excludeSavedTourCaches,
    },
    adventures: {
      include: plan.includeAdventuresInClustering,
      keepTogether: plan.completeAdventuresOnly,
      interleave: plan.adventureInterleave,
    },
    objective: {
      landuseProfileId: plan.landuseProfileId ?? null,
      landuseWeight: plan.landuseWeight,
      centerProximityWeight: plan.centerProximityWeight,
      varietyWeight: plan.varietyWeight,
      preferredTypes: [...plan.preferredTypes],
      preferredWeight: plan.preferredTypeWeight,
    },
    time: {
      visitMinutes: plan.timePerCacheMinutes,
      visitMinutesByType: { ...plan.visitMinutesByType },
      alStageVisitMinutes: plan.alStageVisitMinutes,
      toolBonusMinutes: plan.toolBonusMinutes,
      walkingKmh: plan.avgWalkingKmh,
    },
    budget: {
      distanceBudgetMeters: plan.distanceBudgetMeters,
      durationMinutes: plan.durationMinutes,
      bufferMinutes: plan.bufferMinutes,
    },
    parking: {
      startPreference: plan.startPreference,
      osmAccess: [...plan.osmParkingAccessFilter],
      osmFee: plan.osmParkingFeeFilter,
    },
    advanced: {
      minClusterSize: plan.minClusterSize,
      maxLinkMeters: plan.maxLinkMeters,
      clusteringStrategy: plan.clusteringStrategy,
      topNClusters: plan.topNClusters,
      fringeTrimMeters: plan.fringeTrimMeters,
    },
  });
}

/** True when the planner state no longer matches what the profile sets. */
export function plannerDiffersFromProfile(
  settings: RouteProfileSettings,
  state: PlannerState,
): boolean {
  return canonical(profileFromPlanner(state)) !== canonical(settings);
}

/** Order-insensitive for the list fields, so [a,b] and [b,a] compare equal. */
function canonical(s: RouteProfileSettings): string {
  const sorted = (xs: readonly string[]) => [...xs].sort();
  return JSON.stringify({
    ...s,
    filters: {
      ...s.filters,
      types: sorted(s.filters.types),
      contexts: sorted(s.filters.contexts),
    },
    objective: {
      ...s.objective,
      preferredTypes: sorted(s.objective.preferredTypes),
    },
    time: {
      ...s.time,
      visitMinutesByType: Object.fromEntries(
        Object.entries(s.time.visitMinutesByType).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    },
    parking: { ...s.parking, osmAccess: sorted(s.parking.osmAccess) },
  });
}
