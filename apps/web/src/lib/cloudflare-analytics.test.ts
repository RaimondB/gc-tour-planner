// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module reads VITE_CF_WEB_ANALYTICS_TOKEN at load time, so each test stubs
// the env then imports a fresh copy.
async function loadModule(token?: string) {
  vi.resetModules();
  if (token !== undefined) vi.stubEnv("VITE_CF_WEB_ANALYTICS_TOKEN", token);
  return import("./cloudflare-analytics.js");
}

const beacons = () => document.head.querySelectorAll("script[data-cf-beacon]");

beforeEach(() => {
  document.head.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cloudflare-analytics", () => {
  it("no-ops and reports disabled when no token is set", async () => {
    const mod = await loadModule();
    expect(mod.analyticsEnabled).toBe(false);
    mod.initCloudflareAnalytics();
    expect(beacons()).toHaveLength(0);
  });

  it("no-ops when the token is blank/whitespace", async () => {
    const mod = await loadModule("   ");
    expect(mod.analyticsEnabled).toBe(false);
    mod.initCloudflareAnalytics();
    expect(beacons()).toHaveLength(0);
  });

  it("injects the beacon with the configured token when set", async () => {
    const mod = await loadModule("tok-abc123");
    expect(mod.analyticsEnabled).toBe(true);
    mod.initCloudflareAnalytics();

    const found = beacons();
    expect(found).toHaveLength(1);
    const script = found[0] as HTMLScriptElement;
    expect(script.src).toBe(
      "https://static.cloudflareinsights.com/beacon.min.js",
    );
    expect(script.defer).toBe(true);
    expect(JSON.parse(script.getAttribute("data-cf-beacon")!)).toEqual({
      token: "tok-abc123",
    });
  });

  it("is idempotent — a second call injects no duplicate", async () => {
    const mod = await loadModule("tok-abc123");
    mod.initCloudflareAnalytics();
    mod.initCloudflareAnalytics();
    expect(beacons()).toHaveLength(1);
  });
});
