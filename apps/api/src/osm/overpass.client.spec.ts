// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { normalizeOverpassResponse } from "./overpass.client.js";

describe("normalizeOverpassResponse", () => {
  it("parses a closed way into a single ring polygon", () => {
    const out = normalizeOverpassResponse({
      elements: [
        {
          type: "way",
          id: 1,
          tags: { landuse: "forest" },
          geometry: [
            { lat: 52, lon: 5 },
            { lat: 52, lon: 5.1 },
            { lat: 52.1, lon: 5.1 },
            { lat: 52, lon: 5 },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.osmSource).toBe("way:1");
    expect(out[0]?.kind).toBe("forest");
    expect(out[0]?.polygon.coordinates[0]).toHaveLength(4);
  });

  it("closes an unclosed way before storing", () => {
    const out = normalizeOverpassResponse({
      elements: [
        {
          type: "way",
          id: 2,
          tags: { landuse: "park" },
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
            { lat: 1, lon: 1 },
            // missing closing node
          ],
        },
      ],
    });
    expect(out[0]?.polygon.coordinates[0]?.at(-1)).toEqual([0, 0]);
  });

  it("assembles a relation's already-closed outer way into one polygon", () => {
    const out = normalizeOverpassResponse({
      elements: [
        {
          type: "relation",
          id: 100,
          tags: { type: "multipolygon", landuse: "residential" },
          members: [
            {
              type: "way",
              ref: 50,
              role: "outer",
              geometry: [
                { lat: 0, lon: 0 },
                { lat: 0, lon: 2 },
                { lat: 2, lon: 2 },
                { lat: 2, lon: 0 },
                { lat: 0, lon: 0 },
              ],
            },
            {
              type: "way",
              ref: 51,
              role: "inner",
              geometry: [
                { lat: 0.5, lon: 0.5 },
                { lat: 0.5, lon: 1.5 },
                { lat: 1.5, lon: 1.5 },
                { lat: 0.5, lon: 0.5 },
              ],
            },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.osmSource).toBe("rel:100:0");
    expect(out[0]?.kind).toBe("residential");
    // Inner ring deliberately ignored — MVP fills multipolygons solid.
    expect(out[0]?.polygon.coordinates).toHaveLength(1);
  });

  it("stitches open outer segments that share endpoints into one closed ring", () => {
    const out = normalizeOverpassResponse({
      elements: [
        {
          type: "relation",
          id: 200,
          tags: { type: "multipolygon", landuse: "residential" },
          members: [
            {
              type: "way",
              ref: 1,
              role: "outer",
              geometry: [
                { lat: 0, lon: 0 },
                { lat: 0, lon: 1 },
              ],
            },
            {
              type: "way",
              ref: 2,
              role: "outer",
              geometry: [
                { lat: 0, lon: 1 },
                { lat: 1, lon: 1 },
              ],
            },
            {
              type: "way",
              ref: 3,
              role: "outer",
              geometry: [
                { lat: 1, lon: 1 },
                { lat: 1, lon: 0 },
                { lat: 0, lon: 0 },
              ],
            },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    const ring = out[0]?.polygon.coordinates[0] ?? [];
    expect(ring[0]).toEqual(ring.at(-1));
    expect(ring.length).toBeGreaterThanOrEqual(5);
  });

  it("reverses a segment when needed to make endpoints meet", () => {
    const out = normalizeOverpassResponse({
      elements: [
        {
          type: "relation",
          id: 300,
          tags: { type: "multipolygon", landuse: "forest" },
          members: [
            {
              type: "way",
              ref: 10,
              role: "outer",
              geometry: [
                { lat: 0, lon: 0 },
                { lat: 0, lon: 1 },
                { lat: 1, lon: 1 },
              ],
            },
            // Stored backwards on purpose — should be reversed when stitched.
            {
              type: "way",
              ref: 11,
              role: "outer",
              geometry: [
                { lat: 0, lon: 0 },
                { lat: 1, lon: 0 },
                { lat: 1, lon: 1 },
              ],
            },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("forest");
  });

  it("dedups within a single response (same osmSource appears once)", () => {
    const out = normalizeOverpassResponse({
      elements: [
        {
          type: "way",
          id: 42,
          tags: { landuse: "forest" },
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
            { lat: 1, lon: 1 },
            { lat: 0, lon: 0 },
          ],
        },
        {
          type: "way",
          id: 42,
          tags: { landuse: "forest" },
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
            { lat: 1, lon: 1 },
            { lat: 0, lon: 0 },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
  });
});
