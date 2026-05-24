// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import type { SearchParams } from "../../lib/search-params.js";
import { useMap } from "./MapContext.js";

const SOURCE_ID = "gctp-radius";
const LINE_LAYER = "gctp-radius-line";
const CENTER_SOURCE = "gctp-search-center";
const CENTER_LAYER = "gctp-search-center-dot";

/**
 * Draws a non-interactive circle around the current search center plus a
 * small dot at the center itself. The circle is approximated as a 64-vertex
 * polygon — accurate to a few meters at any reasonable search radius and
 * cheap enough to regenerate on every params change.
 */
export function RadiusLayer({ params }: { params: SearchParams }): null {
  const { map, ready } = useMap();

  useEffect(() => {
    if (!ready) return;

    const polygon = circlePolygon(params.center, params.radiusM);
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: polygon, properties: {} }],
    };
    const centerFc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: params.center },
          properties: {},
        },
      ],
    };

    upsert(map, SOURCE_ID, fc);
    upsert(map, CENTER_SOURCE, centerFc);

    if (!map.getLayer(LINE_LAYER)) {
      map.addLayer(
        {
          id: LINE_LAYER,
          type: "line",
          source: SOURCE_ID,
          paint: {
            "line-color": "#2563eb",
            "line-width": 1.5,
            "line-dasharray": [4, 2],
          },
        },
        firstSymbolOrCachesLayer(map),
      );
    }
    if (!map.getLayer(CENTER_LAYER)) {
      map.addLayer({
        id: CENTER_LAYER,
        type: "circle",
        source: CENTER_SOURCE,
        paint: {
          "circle-radius": 5,
          "circle-color": "#2563eb",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
    }
    return undefined;
  }, [map, ready, params.center, params.radiusM]);

  return null;
}

function upsert(
  map: maplibregl.Map,
  id: string,
  data: GeoJSON.FeatureCollection,
): void {
  const existing = map.getSource(id);
  if (existing && "setData" in existing) {
    (existing as maplibregl.GeoJSONSource).setData(data);
    return;
  }
  map.addSource(id, { type: "geojson", data });
}

/**
 * Place the radius layers below the cache markers so markers stay clickable
 * and visible. Returns undefined if no caches layer exists yet — MapLibre
 * then appends to the top, which is fine for the first paint.
 */
function firstSymbolOrCachesLayer(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle().layers ?? [];
  const cachesLayer = layers.find((l) => l.id === "gctp-caches-circle");
  return cachesLayer?.id;
}

function circlePolygon(
  center: [number, number],
  radiusM: number,
  steps = 64,
): GeoJSON.Polygon {
  const [lng, lat] = center;
  const earthR = 6_378_137; // WGS84 mean radius in meters
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    const dx = radiusM * Math.cos(angle);
    const dy = radiusM * Math.sin(angle);
    const dLat = (dy / earthR) * (180 / Math.PI);
    const dLng = ((dx / earthR) * (180 / Math.PI)) / cosLat;
    ring.push([lng + dLng, lat + dLat]);
  }
  return { type: "Polygon", coordinates: [ring] };
}
