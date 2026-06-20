// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsersRepository } from "../../auth/users.repository.js";
import type { CachesRepository } from "../../caches/caches.repository.js";
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

/** UsersRepository stub whose findById returns the given GC GUID (or null). */
function makeUsers(gcUserGuid: string | null = null): UsersRepository {
  return {
    findById: vi.fn().mockResolvedValue({ id: "owner-1", gcUserGuid }),
  } as unknown as UsersRepository;
}

function makeCaches(): CachesRepository {
  return {
    markFoundByCodes: vi.fn().mockResolvedValue(0),
  } as unknown as CachesRepository;
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
    const enricher = new AdventureLabEnricher(
      cfg,
      gpx,
      makeUsers(),
      makeCaches(),
    );

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
    const caches = makeCaches();
    const enricher = new AdventureLabEnricher(cfg, gpx, makeUsers(), caches);

    const result = await enricher.enrich("owner-1", AREA);

    expect(result).toEqual({ importedCaches: 7, crossedOff: 0 });
    // No GC GUID on the profile ⇒ userGuid null in the request, no cross-off.
    expect(
      JSON.parse(
        (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
      ).userGuid,
    ).toBeNull();
    expect(caches.markFoundByCodes).not.toHaveBeenCalled();
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
      makeUsers(),
      makeCaches(),
    );

    expect(await enricher.enrich("owner-1", AREA)).toBeNull();
    expect(gpx.ingest).not.toHaveBeenCalled();
  });

  it("passes the profile GC GUID to Lab2Gpx and crosses off completed stages (FR-I19)", async () => {
    // A two-stage adventure: S1 found, S2 not. Only S1 should be crossed off.
    const gpxBody = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/0"
           xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
        <wpt lat="52.0" lon="5.0">
          <name>LCDONE1</name>
          <url>https://labs.geocaching.com/goto/adv-guid</url>
          <urlname>S1 Done stage</urlname>
          <sym>Geocache Found</sym>
          <groundspeak:cache id="1" available="True" archived="False">
            <groundspeak:name>Adv : S1 Done stage</groundspeak:name>
            <groundspeak:type>Lab Cache</groundspeak:type>
          </groundspeak:cache>
        </wpt>
        <wpt lat="52.0" lon="5.0">
          <name>LCTODO2</name>
          <url>https://labs.geocaching.com/goto/adv-guid</url>
          <urlname>S2 Todo stage</urlname>
          <sym>Geocache</sym>
          <groundspeak:cache id="2" available="True" archived="False">
            <groundspeak:name>Adv : S2 Todo stage</groundspeak:name>
            <groundspeak:type>Lab Cache</groundspeak:type>
          </groundspeak:cache>
        </wpt>
      </gpx>`;
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => gpxBody });
    vi.stubGlobal("fetch", fetchSpy);
    const gpx = makeGpxService();
    const caches = makeCaches();
    const enricher = new AdventureLabEnricher(
      { enabled: true, apiBaseUrl: "https://example.test" },
      gpx,
      makeUsers("c0ffee00-dead-beef-cafe-000000000001"),
      caches,
    );

    await enricher.enrich("owner-1", AREA);

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.userGuid).toBe("c0ffee00-dead-beef-cafe-000000000001");
    // Only the Found stage's code is crossed off.
    expect(caches.markFoundByCodes).toHaveBeenCalledWith("owner-1", [
      "LCDONE1",
    ]);
  });
});
