// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGpx, stripHtml } from "./parse.js";

const fixturePath = fileURLToPath(
  new URL("../../test/fixtures/sample-pq.gpx", import.meta.url),
);
const gpxText = readFileSync(fixturePath, "utf8");

describe("parseGpx", () => {
  it("parses two caches with their Groundspeak metadata", () => {
    const result = parseGpx(gpxText);

    expect(result.warnings).toEqual([]);
    expect(result.caches).toHaveLength(2);

    const traditional = result.caches.find((c) => c.code === "GCAAA111");
    expect(traditional).toBeDefined();
    expect(traditional?.type).toBe("Traditional");
    expect(traditional?.name).toBe("Forest Walk");
    expect(traditional?.difficulty).toBe(1.5);
    expect(traditional?.terrain).toBe(2);
    expect(traditional?.size).toBe("Small");
    expect(traditional?.archived).toBe(false);
    expect(traditional?.disabled).toBe(false);
    expect(traditional?.descriptionHints).toEqual([]);
    expect(traditional?.location).toEqual([5.1214, 52.0907]);
    expect(traditional?.attributes).toEqual([
      { id: 6, positive: true },
      { id: 40, positive: true },
      { id: 24, positive: false },
    ]);

    const mystery = result.caches.find((c) => c.code === "GCBBB222");
    expect(mystery?.type).toBe("Mystery");
    expect(mystery?.difficulty).toBe(3.5);
  });

  it("classifies additional waypoints (parking, final, reference) and links to parents", () => {
    const result = parseGpx(gpxText);

    expect(result.waypoints).toHaveLength(3);

    const parking = result.waypoints.find((w) => w.type === "parking");
    expect(parking?.parentCode).toBe("GCAAA111");
    expect(parking?.location).toEqual([5.123, 52.092]);

    const final = result.waypoints.find((w) => w.type === "final");
    expect(final?.parentCode).toBe("GCBBB222");

    const reference = result.waypoints.find((w) => w.type === "reference");
    expect(reference?.parentCode).toBe("GCBBB222");
  });

  it("extracts parent cache code from Groundspeak 2-char prefix names", () => {
    // PQ companion files (-wpts.gpx) name waypoints as <2-char-prefix><cache-suffix>:
    // PA = parking, FL = final, TH/T0 = trailhead, 01/02 = numbered stages.
    const xml = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/0">
        <wpt lat="51.87" lon="6.17"><name>PA278XH</name><sym>Parking Area</sym></wpt>
        <wpt lat="51.87" lon="6.17"><name>FL278XH</name><sym>Final Location</sym></wpt>
        <wpt lat="51.87" lon="6.17"><name>T09GQV2</name><sym>Trailhead</sym></wpt>
        <wpt lat="51.87" lon="6.17"><name>018ZQ1F</name><sym>Parking Area</sym></wpt>
        <wpt lat="51.87" lon="6.17"><name>P095W19</name><sym>Parking Area</sym></wpt>
      </gpx>`;
    const result = parseGpx(xml);
    expect(result.waypoints.map((w) => w.parentCode)).toEqual([
      "GC278XH",
      "GC278XH",
      "GC9GQV2",
      "GC8ZQ1F",
      "GC95W19",
    ]);
  });

  it("captures the top-level <gpx><time> as exportedAt (ISO string, UTC)", () => {
    const xml = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/0">
        <time>2026-05-24T08:05:56.3784912Z</time>
      </gpx>`;
    const result = parseGpx(xml);
    expect(result.exportedAt).toBe("2026-05-24T08:05:56.378Z");
  });

  it("yields exportedAt=null when the GPX has no top-level <time>", () => {
    expect(parseGpx(gpxText).exportedAt).toBeNull();
  });

  it("derives disabled from available='False' (with archived='False')", () => {
    const xml = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/0"
           xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
        <wpt lat="52.0" lon="5.0">
          <name>GC1DIS1</name>
          <groundspeak:cache id="1" available="False" archived="False">
            <groundspeak:name>Down for maintenance</groundspeak:name>
            <groundspeak:type>Traditional Cache</groundspeak:type>
          </groundspeak:cache>
        </wpt>
        <wpt lat="52.0" lon="5.0">
          <name>GC1ARC1</name>
          <groundspeak:cache id="2" available="False" archived="True">
            <groundspeak:name>Permanently gone</groundspeak:name>
            <groundspeak:type>Traditional Cache</groundspeak:type>
          </groundspeak:cache>
        </wpt>
      </gpx>`;
    const result = parseGpx(xml);
    const dis = result.caches.find((c) => c.code === "GC1DIS1");
    const arc = result.caches.find((c) => c.code === "GC1ARC1");
    // Temp-disabled: disabled=true, archived=false.
    expect(dis?.disabled).toBe(true);
    expect(dis?.archived).toBe(false);
    // Archived ones report under archived only — the booleans stay
    // orthogonal so the UI can render exactly one badge per cache.
    expect(arc?.disabled).toBe(false);
    expect(arc?.archived).toBe(true);
  });

  it("scans HTML descriptions for tool-hint keywords (multilingual)", () => {
    const xml = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/0"
           xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
        <wpt lat="52.0" lon="5.0">
          <name>GCFISH1</name>
          <groundspeak:cache id="1" available="True" archived="False">
            <groundspeak:name>De Hengel</groundspeak:name>
            <groundspeak:type>Traditional Cache</groundspeak:type>
            <groundspeak:short_description html="True">&lt;p&gt;Vergeet je &lt;b&gt;hengel&lt;/b&gt; niet!&lt;/p&gt;</groundspeak:short_description>
            <groundspeak:long_description html="True">&lt;p&gt;You'll also want binoculars for the view.&lt;/p&gt;</groundspeak:long_description>
          </groundspeak:cache>
        </wpt>
        <wpt lat="52.0" lon="5.0">
          <name>GCNORM1</name>
          <groundspeak:cache id="2" available="True" archived="False">
            <groundspeak:name>Plain</groundspeak:name>
            <groundspeak:type>Traditional Cache</groundspeak:type>
            <groundspeak:long_description html="True">&lt;p&gt;Nothing special here.&lt;/p&gt;</groundspeak:long_description>
          </groundspeak:cache>
        </wpt>
      </gpx>`;
    const result = parseGpx(xml);
    const fish = result.caches.find((c) => c.code === "GCFISH1");
    const norm = result.caches.find((c) => c.code === "GCNORM1");
    // Dutch "hengel" + English "binoculars" both match — order
    // follows the dictionary, not the description.
    expect(fish?.descriptionHints).toEqual(["fishingRod", "binoculars"]);
    // No keywords → empty array.
    expect(norm?.descriptionHints).toEqual([]);
  });

  it("warns on caches with no waypoints and ignores wpts missing coordinates", () => {
    const xml = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/0">
        <wpt><name>NoCoords</name><sym>Parking Area</sym></wpt>
      </gpx>`;
    const result = parseGpx(xml);
    expect(result.caches).toEqual([]);
    expect(result.waypoints).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/missing lat\/lon/);
  });

  it("detects a Groundspeak 'My Finds' Pocket Query from the top-level <name>", () => {
    const xml = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/0">
        <name>My Finds Pocket Query</name>
        <wpt lat="52.0" lon="5.0"><name>GCX1</name>
          <groundspeak:cache xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
            <groundspeak:type>Traditional Cache</groundspeak:type>
          </groundspeak:cache>
        </wpt>
      </gpx>`;
    expect(parseGpx(xml).isMyFinds).toBe(true);
  });

  it("matches the 'My Finds' name leniently (case-insensitive substring)", () => {
    const xml = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/0">
        <name>my finds 2026</name>
        <wpt lat="52.0" lon="5.0"><name>GCX1</name>
          <groundspeak:cache xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
            <groundspeak:type>Traditional Cache</groundspeak:type>
          </groundspeak:cache>
        </wpt>
      </gpx>`;
    expect(parseGpx(xml).isMyFinds).toBe(true);
  });

  it("does not flag a regular Pocket Query as 'My Finds'", () => {
    // Sample fixture is a normal PQ with no top-level <gpx><name>.
    expect(parseGpx(gpxText).isMyFinds).toBe(false);

    const named = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/0">
        <name>Weekend Trail PQ</name>
        <wpt lat="52.0" lon="5.0"><name>GCX1</name>
          <groundspeak:cache xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
            <groundspeak:type>Traditional Cache</groundspeak:type>
          </groundspeak:cache>
        </wpt>
      </gpx>`;
    expect(parseGpx(named).isMyFinds).toBe(false);
  });
});

describe("stripHtml", () => {
  it("strips tags and decodes the common entities", () => {
    expect(stripHtml("<p>Bring a <b>rod</b> &amp; net</p>")).toBe(
      "Bring a rod & net",
    );
    expect(stripHtml("a&nbsp;b&quot;c&#39;d&apos;e")).toBe(`a b"c'd'e`);
  });

  it("decodes &amp; last so it does not double-unescape (regression)", () => {
    // Literal text the author meant to show: `&lt;` and `&gt;`. A naive
    // decoder that resolves &amp; first would re-read the result as `<`/`>`.
    expect(stripHtml("&amp;lt;")).toBe("&lt;");
    expect(stripHtml("&amp;gt;")).toBe("&gt;");
    expect(stripHtml("Fish &amp; Chips")).toBe("Fish & Chips");
  });
});
