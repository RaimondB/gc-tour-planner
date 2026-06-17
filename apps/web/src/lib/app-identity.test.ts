// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { appIdentity, resolveAppEnv } from "./app-identity.js";

describe("resolveAppEnv", () => {
  it("treats only an exact 'production' as production", () => {
    expect(resolveAppEnv("production")).toBe("production");
    expect(resolveAppEnv("  production  ")).toBe("production");
  });

  it("defaults everything else to uat (fail-safe)", () => {
    expect(resolveAppEnv(undefined)).toBe("uat");
    expect(resolveAppEnv("")).toBe("uat");
    expect(resolveAppEnv("   ")).toBe("uat");
    expect(resolveAppEnv("uat")).toBe("uat");
    expect(resolveAppEnv("prod")).toBe("uat");
    expect(resolveAppEnv("Production")).toBe("uat");
  });
});

describe("appIdentity", () => {
  it("is clean in production", () => {
    expect(appIdentity("production")).toEqual({
      iconSuffix: "",
      name: "gc-tour-planner",
      shortName: "GC Tour",
      title: "gc-tour-planner",
    });
  });

  it("badges and suffixes in uat", () => {
    const id = appIdentity("uat");
    expect(id.iconSuffix).toBe("-uat");
    expect(id.name).toBe("gc-tour-planner (UAT)");
    expect(id.shortName).toBe("GC Tour (UAT)");
    expect(id.title).toBe("gc-tour-planner (UAT)");
  });
});
