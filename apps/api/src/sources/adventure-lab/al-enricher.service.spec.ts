// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GpxService } from "../../gpx/gpx.service.js";
import type { AdventureLabConfig } from "./al.config.js";
import { AdventureLabEnricher } from "./al-enricher.service.js";

function makeGpxService(): GpxService {
  return {
    ingest: vi.fn().mockResolvedValue({
      uploadId: "u1",
      cachesUpserted: 7,
      waypointsInserted: 0,
      findsRecorded: 0,
      warnings: [],
      stats: {},
      myFinds: false,
      duplicate: false,
    }),
  } as unknown as GpxService;
}

const AREA = { center: [4.9, 52.37] as [number, number], radiusM: 5_000 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AdventureLabEnricher", () => {
  it("is a no-op when the admin flag is off (no fetch, no ingest)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const gpx = makeGpxService();
    const cfg: AdventureLabConfig = {
      enabled: false,
      apiBaseUrl: "https://example.test",
    };
    const enricher = new AdventureLabEnricher(cfg, gpx);

    expect(enricher.enabled).toBe(false);
    expect(await enricher.enrich("owner-1", AREA)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(gpx.ingest).not.toHaveBeenCalled();
  });

  it("fetches the area from Lab2Gpx and ingests the returned GPX", async () => {
    const gpxBody = "<gpx>…</gpx>";
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => gpxBody,
    });
    vi.stubGlobal("fetch", fetchSpy);
    const gpx = makeGpxService();
    const cfg: AdventureLabConfig = {
      enabled: true,
      apiBaseUrl: "https://example.test",
    };
    const enricher = new AdventureLabEnricher(cfg, gpx);

    const result = await enricher.enrich("owner-1", AREA);

    expect(result).toEqual({ importedCaches: 7 });
    // Correct endpoint.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/download");
    const body = JSON.parse(init.body as string);
    // center is [lng, lat]; Lab2Gpx wants {lat, lon}.
    expect(body.coordinates).toEqual({ lat: 52.37, lon: 4.9 });
    // 5 km radius + 1 km buffer.
    expect(body.radius).toBe(6);
    expect(body.cacheType).toBe("Lab Cache");
    expect(body.outputFormat).toBe("gpx");
    // The fetched GPX is piped straight into the ingest path.
    expect(gpx.ingest).toHaveBeenCalledWith(
      "owner-1",
      "adventure-lab-enrichment.gpx",
      gpxBody,
      {},
    );
  });

  it("returns null and skips ingest when Lab2Gpx errors", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);
    const gpx = makeGpxService();
    const enricher = new AdventureLabEnricher(
      { enabled: true, apiBaseUrl: "https://example.test" },
      gpx,
    );

    expect(await enricher.enrich("owner-1", AREA)).toBeNull();
    expect(gpx.ingest).not.toHaveBeenCalled();
  });
});
