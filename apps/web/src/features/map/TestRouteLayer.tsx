// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import type { TestRouteResponse } from "@gctp/shared/tours";
import { useMap } from "./MapContext.js";

const SOURCE_ID = "gctp-test-route";
const LINE_LAYER = "gctp-test-route-line";

export interface TestRouteLayerProps {
  result: TestRouteResponse | null;
}

/**
 * Renders the LineString returned by `POST /tours/route/test` as a bright
 * green polyline so the user can compare what OSRM *actually* produces
 * against what's in `route_legs`. Auto-clears when `result` is null.
 */
export function TestRouteLayer({ result }: TestRouteLayerProps): null {
  const { map, ready } = useMap();

  useEffect(() => {
    if (!ready) return;
    const route = result?.route;
    if (!route) {
      if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      return;
    }
    const collection: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: route.geometry as GeoJSON.LineString,
          properties: { meters: route.meters, seconds: route.seconds },
        },
      ],
    };
    const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (existing) existing.setData(collection);
    else map.addSource(SOURCE_ID, { type: "geojson", data: collection });

    if (!map.getLayer(LINE_LAYER)) {
      map.addLayer({
        id: LINE_LAYER,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": "#00c853",
          "line-opacity": 0.95,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            3,
            14,
            6,
          ],
        },
      });
    }
  }, [map, ready, result]);

  return null;
}
