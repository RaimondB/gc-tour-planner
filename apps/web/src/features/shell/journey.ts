// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The three mandatory steps of the planning flow (map-first overhaul). These
 * replace the old `SidebarTab = "filter" | "plan" | "tour"` — same enablement
 * semantics, action-labelled for first-time clarity.
 */
export type JourneyStep = "caches" | "clusters" | "tour";

export const JOURNEY_STEPS: readonly JourneyStep[] = [
  "caches",
  "clusters",
  "tour",
];

export const JOURNEY_LABELS: Record<JourneyStep, string> = {
  caches: "Find caches",
  clusters: "Pick a cluster",
  tour: "Plan & export",
};
