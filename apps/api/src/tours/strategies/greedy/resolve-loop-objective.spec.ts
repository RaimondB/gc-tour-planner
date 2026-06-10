// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOW_OVERLAP_OPTIONS,
  readLowOverlapOptions,
  resolveLoopObjective,
} from "./resolve-loop-objective.js";

describe("resolveLoopObjective", () => {
  it("prefers the request objective over the env default", () => {
    expect(resolveLoopObjective("low-overlap", "shortest")).toBe("low-overlap");
  });

  it("falls back to the env default when no request objective", () => {
    expect(resolveLoopObjective(undefined, "low-overlap")).toBe("low-overlap");
  });

  it("falls back to shortest on an unknown/empty env default", () => {
    expect(resolveLoopObjective(undefined, "nonsense")).toBe("shortest");
    expect(resolveLoopObjective(undefined, undefined)).toBe("shortest");
  });
});

describe("readLowOverlapOptions", () => {
  afterEach(() => {
    delete process.env.PLANNER_LOOP_ORDER_BETA;
    delete process.env.PLANNER_LOOP_ORDER_GRID_M;
  });

  it("returns defaults when env is unset", () => {
    expect(readLowOverlapOptions()).toEqual(DEFAULT_LOW_OVERLAP_OPTIONS);
  });

  it("reads overrides from env", () => {
    process.env.PLANNER_LOOP_ORDER_BETA = "2.5";
    process.env.PLANNER_LOOP_ORDER_GRID_M = "40";
    expect(readLowOverlapOptions()).toEqual({ beta: 2.5, gridMeters: 40 });
  });

  it("ignores invalid/negative overrides", () => {
    process.env.PLANNER_LOOP_ORDER_BETA = "-1";
    process.env.PLANNER_LOOP_ORDER_GRID_M = "abc";
    expect(readLowOverlapOptions()).toEqual(DEFAULT_LOW_OVERLAP_OPTIONS);
  });
});
