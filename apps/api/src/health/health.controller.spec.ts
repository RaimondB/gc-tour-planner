// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller.js";

describe("HealthController", () => {
  it("returns ok with a non-negative uptime", () => {
    const result = new HealthController().check();
    expect(result.status).toBe("ok");
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });
});
