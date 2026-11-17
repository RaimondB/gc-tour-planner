// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import { HttpOsrmClient } from "./osrm.client.js";

const config = {
  get: (k: string) => (k === "OSRM_URL" ? "http://osrm:5000" : undefined),
} as unknown as ConfigService;

afterEach(() => vi.unstubAllGlobals());

describe("HttpOsrmClient.table — sources / destinations (ADR-0040)", () => {
  it("asks OSRM for just those rows and columns and maps them back", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: "Ok",
        // 1 source × 2 destinations, as OSRM returns for sources=0&destinations=1;2
        distances: [[100, null]],
        durations: [[72, null]],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpOsrmClient(config);

    const res = await client.table(
      [
        [5.1, 52.1],
        [5.2, 52.1],
        [5.3, 52.1],
      ],
      "foot",
      { sources: [0], destinations: [1, 2] },
    );

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("sources=0");
    expect(url).toContain("destinations=1;2");
    expect(res).toEqual([[{ meters: 100, seconds: 72 }, null]]);
  });
});
