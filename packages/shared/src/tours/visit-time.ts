// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { hasToolRequirement, type CacheType } from "../caches/index.js";

/** The settings that decide how long a stop takes (FR-SF7, ADR-0039). */
export interface VisitTimeModel {
  timePerCacheMinutes: number;
  alStageVisitMinutes: number;
  toolBonusMinutes: number;
  visitMinutesByType?: Partial<Record<CacheType, number>>;
}

/**
 * Minutes spent at one cache: Adventure Lab stages use `alStageVisitMinutes`;
 * other types use their `visitMinutesByType` override or `timePerCacheMinutes`;
 * a cache that needs a tool adds `toolBonusMinutes`. The one definition shared
 * by both planners, the solver request and the ad-hoc walk.
 */
export function visitMinutesFor(
  cache: {
    type: CacheType;
    attributeIds: readonly number[];
    descriptionHints: readonly string[];
  },
  model: VisitTimeModel,
): number {
  const base =
    cache.type === "Adventure Lab"
      ? model.alStageVisitMinutes
      : (model.visitMinutesByType?.[cache.type] ?? model.timePerCacheMinutes);
  const tool = hasToolRequirement(cache.attributeIds, cache.descriptionHints)
    ? model.toolBonusMinutes
    : 0;
  return base + tool;
}
