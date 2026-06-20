// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { loadIngestConfig } from "./ingest.config.js";

/** Minimal ConfigService stub backed by a plain record. */
function cfg(env: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string): T => env[key] as unknown as T,
  } as unknown as ConfigService;
}

describe("loadIngestConfig", () => {
  it("disabled by default — short-circuits with null key/owner", () => {
    expect(loadIngestConfig(cfg({}))).toEqual({
      enabled: false,
      apiKey: null,
      ownerId: null,
    });
  });

  it("enabled with key + owner resolves both (trimmed)", () => {
    const c = loadIngestConfig(
      cfg({
        INGEST_API_ENABLED: "1",
        INGEST_API_KEY: "  k  ",
        INGEST_OWNER_ID: " owner ",
      }),
    );
    expect(c).toEqual({ enabled: true, apiKey: "k", ownerId: "owner" });
  });

  it("refuses to boot when enabled but key is blank", () => {
    expect(() =>
      loadIngestConfig(
        cfg({ INGEST_API_ENABLED: "true", INGEST_OWNER_ID: "owner" }),
      ),
    ).toThrow(/INGEST_API_KEY/);
  });

  it("refuses to boot when enabled but owner is blank", () => {
    expect(() =>
      loadIngestConfig(cfg({ INGEST_API_ENABLED: "1", INGEST_API_KEY: "k" })),
    ).toThrow(/INGEST_OWNER_ID/);
  });
});
