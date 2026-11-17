// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type * as maplibregl from "maplibre-gl";
import type { WalkReplanResult } from "@gctp/shared/walks";
import { useMap } from "./MapContext.js";
import { applyLayerOrder } from "./map-layers.js";

const PATH_SRC = "gctp-walk-path-src";
const STOPS_SRC = "gctp-walk-stops-src";
const RETURN_SRC = "gctp-walk-return-src";
export const WALK_PATH_LINE = "gctp-walk-path-line";
export const WALK_STOPS_CIRCLE = "gctp-walk-stops-circle";
export const WALK_STOPS_LABEL = "gctp-walk-stops-label";
export const WALK_RETURN_CIRCLE = "gctp-walk-return-circle";
export const WALK_RETURN_LABEL = "gctp-walk-return-label";

const WALK_GREEN = "#15803d";
const DONE_GRAY = "#9ca3af";
const SYMBOL_FONT: string[] = ["Noto Sans Bold"];

export interface WalkLayerProps {
  plan: WalkReplanResult | null;
  /** Stops already visited / skipped on this walk, drawn gray with ✓ / –. */
  done: readonly { location: [number, number]; mark: string }[];
  returnPoint: [number, number] | null;
}

function upsert(
  map: maplibregl.Map,
  id: string,
  data: GeoJSON.FeatureCollection,
): void {
  const existing = map.getSource(id);
  if (existing && "setData" in existing) {
    (existing as maplibregl.GeoJSONSource).setData(data);
  } else {
    map.addSource(id, { type: "geojson", data });
  }
}

const point = (
  coordinates: [number, number],
  properties: Record<string, unknown>,
): GeoJSON.Feature => ({
  type: "Feature",
  properties,
  geometry: { type: "Point", coordinates },
});

/**
 * The ad-hoc walk on the map (FR-T18): the tentative path, numbered upcoming
 * stops, gray visited ones, and the return point. Ready-gated, idempotent
 * re-adders like every layer (ADR-0029), so it survives a map recreate.
 */
export function WalkLayer({ plan, done, returnPoint }: WalkLayerProps): null {
  const { map, ready } = useMap();

  useEffect(() => {
    if (!ready) return;
    const empty: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [],
    };
    upsert(
      map,
      PATH_SRC,
      plan?.geometry
        ? {
            type: "FeatureCollection",
            features: [
              { type: "Feature", properties: {}, geometry: plan.geometry },
            ],
          }
        : empty,
    );
    upsert(map, STOPS_SRC, {
      type: "FeatureCollection",
      features: [
        ...(plan?.order ?? []).map((s, i) =>
          point(s.location, { label: String(i + 1), done: 0 }),
        ),
        ...done.map((d) => point(d.location, { label: d.mark, done: 1 })),
      ],
    });
    upsert(
      map,
      RETURN_SRC,
      returnPoint
        ? { type: "FeatureCollection", features: [point(returnPoint, {})] }
        : empty,
    );

    if (!map.getLayer(WALK_PATH_LINE)) {
      map.addLayer({
        id: WALK_PATH_LINE,
        type: "line",
        source: PATH_SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": WALK_GREEN,
          "line-width": 4,
          "line-opacity": 0.8,
          "line-dasharray": [2, 1.5],
        },
      });
    }
    if (!map.getLayer(WALK_STOPS_CIRCLE)) {
      map.addLayer({
        id: WALK_STOPS_CIRCLE,
        type: "circle",
        source: STOPS_SRC,
        paint: {
          "circle-radius": 11,
          "circle-color": [
            "case",
            ["==", ["get", "done"], 1],
            DONE_GRAY,
            WALK_GREEN,
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
    }
    if (!map.getLayer(WALK_STOPS_LABEL)) {
      map.addLayer({
        id: WALK_STOPS_LABEL,
        type: "symbol",
        source: STOPS_SRC,
        layout: {
          "text-field": ["get", "label"],
          "text-font": SYMBOL_FONT,
          "text-size": 12,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#ffffff" },
      });
    }
    if (!map.getLayer(WALK_RETURN_CIRCLE)) {
      map.addLayer({
        id: WALK_RETURN_CIRCLE,
        type: "circle",
        source: RETURN_SRC,
        paint: {
          "circle-radius": 13,
          "circle-color": "#1e3a8a",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
        },
      });
    }
    if (!map.getLayer(WALK_RETURN_LABEL)) {
      map.addLayer({
        id: WALK_RETURN_LABEL,
        type: "symbol",
        source: RETURN_SRC,
        layout: {
          "text-field": "R",
          "text-font": SYMBOL_FONT,
          "text-size": 13,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#ffffff" },
      });
    }
    applyLayerOrder(map);
  }, [map, ready, plan, done, returnPoint]);

  return null;
}
