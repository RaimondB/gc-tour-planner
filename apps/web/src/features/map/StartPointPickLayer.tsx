// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import { useMap } from "./MapContext.js";

const SOURCE_ID = "gctp-start-pick";
const CIRCLE_LAYER = "gctp-start-pick-circle";
const LABEL_LAYER = "gctp-start-pick-label";

/**
 * Pre-plan preview of the start point the user set by clicking the map
 * (`startPreference === "user-supplied-point"`). Amber "P" so it reads as a
 * tentative choice, distinct from the planned blue parking marker (TourLayer)
 * that replaces it once a tour is planned, and from the red "no parking"
 * fallback marker. Renders nothing unless `point` is set.
 */
export function StartPointPickLayer({
  point,
}: {
  point: [number, number] | null;
}): null {
  const { map, ready } = useMap();

  useEffect(() => {
    if (!ready) return;
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: point
        ? [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: point },
            },
          ]
        : [],
    };

    const existing = map.getSource(SOURCE_ID);
    if (existing && "setData" in existing) {
      (existing as maplibregl.GeoJSONSource).setData(fc);
    } else {
      map.addSource(SOURCE_ID, { type: "geojson", data: fc });
    }
    if (!map.getLayer(CIRCLE_LAYER)) {
      map.addLayer({
        id: CIRCLE_LAYER,
        type: "circle",
        source: SOURCE_ID,
        paint: {
          "circle-radius": 11,
          "circle-color": "#f9a825",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
    }
    if (!map.getLayer(LABEL_LAYER)) {
      map.addLayer({
        id: LABEL_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        layout: {
          "text-field": "P",
          "text-font": ["Noto Sans Bold"],
          "text-size": 13,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#ffffff" },
      });
    }
  }, [map, ready, point]);

  return null;
}
