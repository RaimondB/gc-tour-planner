// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGpx } from "./parse.js";

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
});
