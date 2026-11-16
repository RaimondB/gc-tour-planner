// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { RouteProfileSettings } from "@gctp/shared/route-profiles";
import type { SearchParams } from "../../lib/search-params.js";
import type { PlanSettings } from "../planning/PlannerSidebar.js";

/**
 * Route profile ↔ classic-planner settings (ADR-0039 §4). Pure, so the planner
 * gains profiles without any new planner input: a profile is just a way to fill
 * the existing search filters and plan settings.
 */

export interface PlannerState {
  search: SearchParams;
  plan: PlanSettings;
}

/** Fill the search filters + plan settings a profile covers; keep the rest. */
export function applyRouteProfile(
  settings: RouteProfileSettings,
  { search, plan }: PlannerState,
): PlannerState {
  const { filters, adventures, objective, time, budget } = settings;
  return {
    search: {
      ...search,
      types: [...filters.types],
      multiSubtype: filters.multiSubtype,
      hideToolCaches: filters.hideToolCaches,
      solvedMysteriesOnly: filters.solvedMysteriesOnly,
      contexts: [...filters.contexts],
      difficulty: { ...filters.difficulty },
      terrain: { ...filters.terrain },
    },
    plan: {
      ...plan,
      includeAdventuresInClustering: filters.includeAdventureLabs,
      excludeSavedTourCaches: filters.excludeSavedTourCaches,
      completeAdventuresOnly: adventures.keepTogether,
      adventureInterleave: adventures.interleave,
      landuseProfileId: objective.landuseProfileId ?? undefined,
      landuseWeight: objective.landuseWeight,
      timePerCacheMinutes: time.visitMinutes,
      alStageVisitMinutes: time.alStageVisitMinutes,
      toolBonusMinutes: time.toolBonusMinutes,
      avgWalkingKmh: time.walkingKmh,
      distanceBudgetMeters: budget.distanceBudgetMeters,
    },
  };
}

/**
 * Build profile settings from the current planner state. Fields the classic
 * planner doesn't use (variety, preferred types, per-type visit times, walk
 * buffer and duration) are kept from `base`, or defaulted.
 */
export function profileFromPlanner(
  { search, plan }: PlannerState,
  base?: RouteProfileSettings,
): RouteProfileSettings {
  const from = base ?? RouteProfileSettings.parse({});
  return RouteProfileSettings.parse({
    ...from,
    filters: {
      ...from.filters,
      types: [...search.types],
      multiSubtype: search.multiSubtype,
      hideToolCaches: search.hideToolCaches,
      solvedMysteriesOnly: search.solvedMysteriesOnly,
      contexts: [...search.contexts],
      difficulty: { ...search.difficulty },
      terrain: { ...search.terrain },
      includeAdventureLabs: plan.includeAdventuresInClustering,
      excludeSavedTourCaches: plan.excludeSavedTourCaches,
    },
    adventures: {
      keepTogether: plan.completeAdventuresOnly,
      interleave: plan.adventureInterleave,
    },
    objective: {
      ...from.objective,
      landuseProfileId: plan.landuseProfileId ?? null,
      landuseWeight: plan.landuseWeight,
    },
    time: {
      ...from.time,
      visitMinutes: plan.timePerCacheMinutes,
      alStageVisitMinutes: plan.alStageVisitMinutes,
      toolBonusMinutes: plan.toolBonusMinutes,
      walkingKmh: plan.avgWalkingKmh,
    },
    budget: {
      ...from.budget,
      distanceBudgetMeters: plan.distanceBudgetMeters,
    },
  });
}

/** True when the planner state no longer matches what the profile sets. */
export function plannerDiffersFromProfile(
  settings: RouteProfileSettings,
  state: PlannerState,
): boolean {
  return canonical(profileFromPlanner(state, settings)) !== canonical(settings);
}

/** Order-insensitive for the list fields, so [a,b] and [b,a] compare equal. */
function canonical(s: RouteProfileSettings): string {
  return JSON.stringify({
    ...s,
    filters: {
      ...s.filters,
      types: [...s.filters.types].sort(),
      contexts: [...s.filters.contexts].sort(),
    },
    objective: {
      ...s.objective,
      preferredTypes: [...s.objective.preferredTypes].sort(),
    },
  });
}
