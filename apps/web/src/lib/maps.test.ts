// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { googleMapsDirUrl, parkingNavTarget } from "./maps.js";

// GeoJSON order is [lng, lat]; the parking sits at lat 52.1, lng 5.2.
const PARKING = { coordinates: [5.2, 52.1] as const };

function stubUa(userAgent: string, maxTouchPoints = 0): void {
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("googleMapsDirUrl", () => {
  it("builds a Google Maps directions web URL with lat,lng order", () => {
    expect(googleMapsDirUrl(PARKING)).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=52.1,5.2",
    );
  });
});

describe("parkingNavTarget", () => {
  it("uses the Google Maps navigation intent on Android (offline-capable)", () => {
    stubUa(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0",
    );
    expect(parkingNavTarget(PARKING)).toEqual({
      href: "google.navigation:q=52.1,5.2",
      external: false,
    });
  });

  it("uses Apple Maps directions on iPhone (offline-capable)", () => {
    stubUa(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    );
    expect(parkingNavTarget(PARKING)).toEqual({
      href: "maps://?daddr=52.1,5.2&dirflg=d",
      external: false,
    });
  });

  it("treats iPadOS-13+-as-desktop-Safari (Macintosh + touch) as iOS", () => {
    stubUa(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
      5,
    );
    expect(parkingNavTarget(PARKING).href).toBe(
      "maps://?daddr=52.1,5.2&dirflg=d",
    );
  });

  it("keeps the shareable Google Maps web URL on desktop, opened externally", () => {
    stubUa(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0",
    );
    expect(parkingNavTarget(PARKING)).toEqual({
      href: "https://www.google.com/maps/dir/?api=1&destination=52.1,5.2",
      external: true,
    });
  });
});
