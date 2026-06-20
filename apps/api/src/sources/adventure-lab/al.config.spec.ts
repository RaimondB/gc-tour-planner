// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { loadAdventureLabConfig } from "./al.config.js";

/** Minimal ConfigService stub backed by a plain record. */
function cfg(env: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string): T => env[key] as unknown as T,
  } as unknown as ConfigService;
}

describe("loadAdventureLabConfig", () => {
  it("disabled by default with the public Lab2Gpx URL", () => {
    expect(loadAdventureLabConfig(cfg({}))).toEqual({
      enabled: false,
      apiBaseUrl: "https://api.lab2gpx.gcutils.de",
    });
  });

  it("enables on '1' or 'true' and honours a URL override", () => {
    expect(
      loadAdventureLabConfig(cfg({ ADVENTURE_LAB_ENRICHMENT_ENABLED: "1" }))
        .enabled,
    ).toBe(true);
    expect(
      loadAdventureLabConfig(cfg({ ADVENTURE_LAB_ENRICHMENT_ENABLED: "true" }))
        .enabled,
    ).toBe(true);
    expect(
      loadAdventureLabConfig(
        cfg({
          ADVENTURE_LAB_ENRICHMENT_ENABLED: "1",
          ADVENTURE_LAB_API_URL: "https://staging.example/api",
        }),
      ).apiBaseUrl,
    ).toBe("https://staging.example/api");
  });

  it("treats any other value as off", () => {
    expect(
      loadAdventureLabConfig(cfg({ ADVENTURE_LAB_ENRICHMENT_ENABLED: "yes" }))
        .enabled,
    ).toBe(false);
  });
});
