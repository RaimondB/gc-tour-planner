// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pure resolver + env reader for the Pass-2 loop objective (ADR-0024). Mirrors
// the clustering-strategy registry: the per-plan `loopObjective` wins, falling
// back to the `PLANNER_LOOP_OBJECTIVE` env default and finally `shortest`. No
// I/O, no NestJS.

import type { Tours } from "@gctp/shared";

const LOOP_OBJECTIVES: readonly Tours.LoopObjectiveName[] = [
  "shortest",
  "low-overlap",
];

/**
 * Pick the loop objective for a request. Request-supplied wins; falls back to
 * the env default (`PLANNER_LOOP_OBJECTIVE`), then `shortest`. Unknown values
 * fall back rather than throwing — a mistyped env var quietly degrades to the
 * proven shortest-distance solver.
 */
export function resolveLoopObjective(
  requestObjective: Tours.LoopObjectiveName | undefined,
  envDefault: string | undefined,
): Tours.LoopObjectiveName {
  return requestObjective ?? coerceObjective(envDefault) ?? "shortest";
}

function coerceObjective(
  value: string | undefined,
): Tours.LoopObjectiveName | undefined {
  if (!value) return undefined;
  return (LOOP_OBJECTIVES as readonly string[]).includes(value)
    ? (value as Tours.LoopObjectiveName)
    : undefined;
}

/** Tunables for the `low-overlap` solver (ignored by `shortest`). */
export interface LowOverlapEnvOptions {
  /** Weight on retrace in `dist + β · retrace`. `PLANNER_LOOP_ORDER_BETA`. */
  beta: number;
  /** Straight-line proxy grid size (m). `PLANNER_LOOP_ORDER_GRID_M`. */
  gridMeters: number;
}

export const DEFAULT_LOW_OVERLAP_OPTIONS: LowOverlapEnvOptions = {
  beta: 0.8,
  gridMeters: 25,
};

/**
 * Read the low-overlap tunables from env, falling back to defaults. Separate
 * from the post-order loop-picker knobs (`PLANNER_LOOP_*`): this shapes the
 * cache *order*, the picker refines *realised geometry* — see ADR-0024.
 */
export function readLowOverlapOptions(): LowOverlapEnvOptions {
  const num = (envKey: string, fallback: number): number => {
    const raw = process.env[envKey];
    if (!raw) return fallback;
    const v = Number.parseFloat(raw);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    beta: num("PLANNER_LOOP_ORDER_BETA", DEFAULT_LOW_OVERLAP_OPTIONS.beta),
    gridMeters: num(
      "PLANNER_LOOP_ORDER_GRID_M",
      DEFAULT_LOW_OVERLAP_OPTIONS.gridMeters,
    ),
  };
}
