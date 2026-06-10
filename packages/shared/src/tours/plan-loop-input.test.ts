// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { PlanLoopInput } from "./plan-loop-input.js";

describe("PlanLoopInput.loopObjective", () => {
  const base = { cacheIds: [1, 2, 3] };

  it("is optional — omitted leaves it undefined for the server to resolve", () => {
    const parsed = PlanLoopInput.parse(base);
    expect(parsed.loopObjective).toBeUndefined();
  });

  it("accepts the two known objectives", () => {
    expect(
      PlanLoopInput.parse({ ...base, loopObjective: "shortest" }).loopObjective,
    ).toBe("shortest");
    expect(
      PlanLoopInput.parse({ ...base, loopObjective: "low-overlap" })
        .loopObjective,
    ).toBe("low-overlap");
  });

  it("rejects an unknown objective", () => {
    expect(() =>
      PlanLoopInput.parse({ ...base, loopObjective: "fastest" }),
    ).toThrow();
  });
});
