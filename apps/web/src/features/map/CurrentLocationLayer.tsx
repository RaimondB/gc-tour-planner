// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import { metersPerDegreeLat, metersPerDegreeLng } from "@gctp/shared/geo";
import { useMap } from "./MapContext.js";
import { applyLayerOrder } from "./map-layers.js";

const SOURCE = "gctp-user-location-src";
const ACCURACY_SOURCE = "gctp-user-location-accuracy-src";
const DOT_LAYER = "gctp-user-location-dot";
const ACCURACY_LAYER = "gctp-user-location-accuracy";

/** Above this the accuracy ring is too vague to be useful — hide it (keep the dot). */
const MAX_ACCURACY_RING_M = 2_000;

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** A geodesic-ish circle polygon (center + radius in metres) for the accuracy ring. */
function circlePolygon(
  [lng, lat]: [number, number],
  radiusM: number,
  steps = 48,
): GeoJSON.Feature {
  const dLat = radiusM / metersPerDegreeLat(lat);
  const dLng = radiusM / metersPerDegreeLng(lat);
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  };
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

/**
 * Renders the user's current GPS position as a "you are here" dot plus a
 * translucent accuracy ring (ADR-location). Fed by the app-wide `LocationProvider`
 * — pass `position`/`accuracyM` from `useLocation()`. Renders nothing (empty
 * sources) when there is no fix. Guarded on the map `ready` flag like every layer.
 */
export function CurrentLocationLayer({
  position,
  accuracyM,
}: {
  position: [number, number] | null;
  accuracyM: number | null;
}): null {
  const { map, ready } = useMap();

  useEffect(() => {
    if (!ready) return;

    const dotFc: GeoJSON.FeatureCollection = position
      ? {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: position },
            },
          ],
        }
      : emptyFc();

    const showRing =
      position != null &&
      accuracyM != null &&
      accuracyM > 0 &&
      accuracyM <= MAX_ACCURACY_RING_M;
    const accFc: GeoJSON.FeatureCollection = showRing
      ? {
          type: "FeatureCollection",
          features: [circlePolygon(position, accuracyM)],
        }
      : emptyFc();

    upsert(map, ACCURACY_SOURCE, accFc);
    upsert(map, SOURCE, dotFc);

    if (!map.getLayer(ACCURACY_LAYER)) {
      map.addLayer({
        id: ACCURACY_LAYER,
        type: "fill",
        source: ACCURACY_SOURCE,
        paint: { "fill-color": "#2563eb", "fill-opacity": 0.12 },
      });
    }
    if (!map.getLayer(DOT_LAYER)) {
      map.addLayer({
        id: DOT_LAYER,
        type: "circle",
        source: SOURCE,
        paint: {
          "circle-radius": 7,
          "circle-color": "#2563eb",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2.5,
        },
      });
    }

    applyLayerOrder(map);
  }, [map, ready, position, accuracyM]);

  return null;
}
