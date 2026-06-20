// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { IngestConfig } from "./ingest.config.js";
import { EnvIngestTokenResolver } from "./ingest-token-resolver.js";

const enabled: IngestConfig = {
  enabled: true,
  apiKey: "secret-key-123",
  ownerId: "11111111-1111-1111-1111-111111111111",
};

describe("EnvIngestTokenResolver", () => {
  it("resolves the correct key to the configured owner", async () => {
    const r = new EnvIngestTokenResolver(enabled);
    expect(await r.resolve("secret-key-123")).toEqual({
      ownerId: enabled.ownerId,
    });
  });

  it("returns null for a wrong token", async () => {
    const r = new EnvIngestTokenResolver(enabled);
    expect(await r.resolve("wrong")).toBeNull();
    expect(await r.resolve("secret-key-124")).toBeNull();
  });

  it("returns null for an empty token", async () => {
    const r = new EnvIngestTokenResolver(enabled);
    expect(await r.resolve("")).toBeNull();
  });

  it("returns null when the feature is disabled (null key/owner)", async () => {
    const r = new EnvIngestTokenResolver({
      enabled: false,
      apiKey: null,
      ownerId: null,
    });
    expect(await r.resolve("anything")).toBeNull();
  });
});
