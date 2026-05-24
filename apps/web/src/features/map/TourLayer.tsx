// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import type { PlanResult } from "@gctp/shared/tours";
import { useMap } from "./MapContext.js";

const TOUR_SOURCE = "gctp-tour";
const TOUR_LAYER = "gctp-tour-line";
const TOUR_HALO_LAYER = "gctp-tour-halo";
const PARKING_SOURCE = "gctp-tour-parking";
const PARKING_LAYER = "gctp-tour-parking-circle";
const PARKING_LABEL_LAYER = "gctp-tour-parking-label";

/**
 * Renders the planned tour polyline + parking marker on the map.
 *
 * Source/layer ids are namespaced `gctp-tour-*` so they coexist with the
 * `gctp-caches-*` set from `CachesLayer`. Renders nothing when `result` is null.
 */
export function TourLayer({ result }: { result: PlanResult | null }): null {
  const { map, ready } = useMap();

  useEffect(() => {
    if (!ready) return;

    const tourFc: GeoJSON.FeatureCollection = result
      ? {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: result.polyline,
              properties: {},
            },
          ],
        }
      : { type: "FeatureCollection", features: [] };

    const parkingFc: GeoJSON.FeatureCollection = result
      ? {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: result.parking.point,
              properties: { type: result.parking.type },
            },
          ],
        }
      : { type: "FeatureCollection", features: [] };

    upsertGeoJsonSource(map, TOUR_SOURCE, tourFc);
    upsertGeoJsonSource(map, PARKING_SOURCE, parkingFc);

    if (!map.getLayer(TOUR_HALO_LAYER)) {
      map.addLayer({
        id: TOUR_HALO_LAYER,
        type: "line",
        source: TOUR_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            9,
            5,
            14,
            10,
          ],
          "line-opacity": 0.85,
        },
      });
    }
    if (!map.getLayer(TOUR_LAYER)) {
      map.addLayer({
        id: TOUR_LAYER,
        type: "line",
        source: TOUR_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#d84315",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            9,
            2.5,
            14,
            5,
          ],
        },
      });
    }
    if (!map.getLayer(PARKING_LAYER)) {
      map.addLayer({
        id: PARKING_LAYER,
        type: "circle",
        source: PARKING_SOURCE,
        paint: {
          "circle-radius": 11,
          "circle-color": "#1565c0",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
    }
    if (!map.getLayer(PARKING_LABEL_LAYER)) {
      map.addLayer({
        id: PARKING_LABEL_LAYER,
        type: "symbol",
        source: PARKING_SOURCE,
        layout: {
          "text-field": "P",
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": 13,
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#ffffff",
        },
      });
    }
  }, [map, ready, result]);

  // Auto-fit the camera to the polyline whenever a new tour is planned.
  useEffect(() => {
    if (!ready || !result) return;
    const coords = result.polyline.coordinates;
    if (coords.length < 2) return;
    let minLng = coords[0]![0];
    let minLat = coords[0]![1];
    let maxLng = minLng;
    let maxLat = minLat;
    for (const [lng, lat] of coords) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 60, duration: 600 },
    );
  }, [map, ready, result]);

  return null;
}

function upsertGeoJsonSource(
  map: maplibregl.Map,
  id: string,
  collection: GeoJSON.FeatureCollection,
): void {
  const existing = map.getSource(id);
  if (existing && "setData" in existing) {
    (existing as maplibregl.GeoJSONSource).setData(collection);
    return;
  }
  map.addSource(id, { type: "geojson", data: collection });
}
