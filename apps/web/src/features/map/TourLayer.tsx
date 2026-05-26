// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import type { CacheDTO } from "@gctp/shared/caches";
import type { PlanResult } from "@gctp/shared/tours";
import { useMap } from "./MapContext.js";

const TOUR_SOURCE = "gctp-tour";
const TOUR_LAYER = "gctp-tour-line";
const TOUR_HALO_LAYER = "gctp-tour-halo";
const TOUR_ARROW_LAYER = "gctp-tour-arrows";
const PARKING_SOURCE = "gctp-tour-parking";
const PARKING_LAYER = "gctp-tour-parking-circle";
const PARKING_LABEL_LAYER = "gctp-tour-parking-label";
const STOP_SOURCE = "gctp-tour-stops";
const STOP_CIRCLE_LAYER = "gctp-tour-stops-circle";
const STOP_LABEL_LAYER = "gctp-tour-stops-label";
const DROPPED_SOURCE = "gctp-tour-dropped";
const DROPPED_CIRCLE_LAYER = "gctp-tour-dropped-circle";
const DROPPED_LABEL_LAYER = "gctp-tour-dropped-label";

// Single font, not a stack. MapLibre encodes `text-font: [a, b, c]` as a
// comma-joined `{glyphs}/a,b,c/0-255.pbf` request, and demotiles (the
// fallback style's glyph server) 404s on anything that isn't a single
// known font name. Stick to one font that exists on every common glyph
// source: Noto Sans Bold ships in demotiles, MapTiler styles, and OSM's
// own font sources.
const SYMBOL_FONT: string[] = ["Noto Sans Bold"];

/**
 * Renders the planned tour on the map:
 *  - the polyline + a white halo behind it
 *  - direction arrows repeated along the line (line-symbol layer)
 *  - the parking marker
 *  - one numbered stop badge per cache in visit order (1, 2, …)
 *
 * Source/layer ids are namespaced `gctp-tour-*` so they coexist with the
 * `gctp-caches-*` set from `CachesLayer`. Renders nothing when `result` is
 * null. The `caches` prop is the same array `CachesLayer` already paints;
 * we use it to resolve `orderedCacheIds` -> coordinates for the numbered
 * stops.
 */
export function TourLayer({
  result,
  caches,
}: {
  result: PlanResult | null;
  caches: readonly CacheDTO[] | undefined;
}): null {
  const { map, ready } = useMap();

  useEffect(() => {
    if (!ready) return;

    if (result && import.meta.env.DEV) {
      // Dev-only diagnostic so the operator can confirm the planner came
      // back with a real polyline (and not a silently-degenerate result
      // like `coordinates: [[0,0],[0,0]]` that renders as "no tour").
      const n = result.polyline?.coordinates?.length ?? 0;
      // eslint-disable-next-line no-console
      console.info(
        `[gctp-tour] rendering tour: ${result.orderedCacheIds.length} caches, ${n}-point polyline`,
      );
    }

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

    // Numbered visit-order stops. Look up each ordered cache's coordinates
    // from the caches list (same array CachesLayer paints) — without this
    // we'd need a separate fetch just to get coordinates the page already
    // has. If `caches` hasn't loaded yet we render an empty FC and the
    // layer simply has nothing to draw.
    const cacheById = new Map<number, CacheDTO>();
    for (const c of caches ?? []) cacheById.set(c.id, c);
    const stopsFc: GeoJSON.FeatureCollection = result
      ? {
          type: "FeatureCollection",
          features: result.orderedCacheIds
            .map<GeoJSON.Feature | null>((id, i) => {
              const cache = cacheById.get(id);
              if (!cache) return null;
              return {
                type: "Feature",
                geometry: cache.location,
                properties: {
                  order: i + 1,
                  code: cache.code,
                },
              };
            })
            .filter((f): f is GeoJSON.Feature => f !== null),
        }
      : { type: "FeatureCollection", features: [] };

    // Dropped-by-trim caches. The planner's marginal-cost trim
    // intentionally skips caches whose inclusion would force a long
    // detour. Without a dedicated marker the user can't tell whether
    // an unvisited cache was "trimmed by the planner" or just "not in
    // the cluster" — both look identical to CachesLayer.
    const droppedFc: GeoJSON.FeatureCollection = result
      ? {
          type: "FeatureCollection",
          features: result.droppedCacheIds
            .map<GeoJSON.Feature | null>((id) => {
              const cache = cacheById.get(id);
              if (!cache) return null;
              return {
                type: "Feature",
                geometry: cache.location,
                properties: {
                  code: cache.code,
                },
              };
            })
            .filter((f): f is GeoJSON.Feature => f !== null),
        }
      : { type: "FeatureCollection", features: [] };

    upsertGeoJsonSource(map, TOUR_SOURCE, tourFc);
    upsertGeoJsonSource(map, PARKING_SOURCE, parkingFc);
    upsertGeoJsonSource(map, STOP_SOURCE, stopsFc);
    upsertGeoJsonSource(map, DROPPED_SOURCE, droppedFc);

    // Each layer is wrapped so a single MapLibre throw (font/glyph not
    // available, expression invalid) doesn't take out the rest of the
    // tour layers. Lines render even when symbols fail.
    const addLayerSafe = (
      id: string,
      spec: maplibregl.LayerSpecification,
    ): void => {
      if (map.getLayer(id)) return;
      try {
        map.addLayer(spec);
      } catch (err) {
        console.warn(
          `[gctp-tour] addLayer(${id}) failed:`,
          (err as Error).message,
        );
      }
    };

    addLayerSafe(TOUR_HALO_LAYER, {
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
    addLayerSafe(TOUR_LAYER, {
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
    // Direction arrows: a symbol layer placed along the line at a fixed
    // pixel spacing. Plain ASCII '>' renders in every font; MapLibre
    // rotates the glyph to the line's tangent (so the return leg shows
    // as '<'). Larger gap at low zoom so the line doesn't disappear under
    // arrows when fitted to bounds.
    addLayerSafe(TOUR_ARROW_LAYER, {
      id: TOUR_ARROW_LAYER,
      type: "symbol",
      source: TOUR_SOURCE,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          120,
          14,
          80,
          17,
          60,
        ],
        "text-field": ">",
        "text-font": SYMBOL_FONT,
        "text-size": 18,
        "text-keep-upright": false,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#d84315",
        "text-halo-width": 1.8,
      },
    });
    addLayerSafe(PARKING_LAYER, {
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
    addLayerSafe(PARKING_LABEL_LAYER, {
      id: PARKING_LABEL_LAYER,
      type: "symbol",
      source: PARKING_SOURCE,
      layout: {
        "text-field": "P",
        "text-font": SYMBOL_FONT,
        "text-size": 13,
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#ffffff",
      },
    });
    // Numbered visit-order badges. Bigger circle than the cache markers
    // CachesLayer paints so the order is visible without zooming in;
    // text-allow-overlap so they never get culled even when caches sit
    // closely together.
    addLayerSafe(STOP_CIRCLE_LAYER, {
      id: STOP_CIRCLE_LAYER,
      type: "circle",
      source: STOP_SOURCE,
      paint: {
        "circle-radius": 12,
        "circle-color": "#d84315",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
    addLayerSafe(STOP_LABEL_LAYER, {
      id: STOP_LABEL_LAYER,
      type: "symbol",
      source: STOP_SOURCE,
      layout: {
        "text-field": ["to-string", ["get", "order"]],
        "text-font": SYMBOL_FONT,
        "text-size": 13,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#ffffff",
      },
    });
    // Trimmed-by-planner caches. Gray fill with a bright stroke
    // (visually muted vs. the red numbered stops, but stands out vs.
    // the small caches-layer markers — "we deliberately skipped this").
    // Label is a single 'x' to read as "not visited"; size matches
    // the stops so users can pick it out at any zoom level.
    addLayerSafe(DROPPED_CIRCLE_LAYER, {
      id: DROPPED_CIRCLE_LAYER,
      type: "circle",
      source: DROPPED_SOURCE,
      paint: {
        "circle-radius": 12,
        "circle-color": "#9e9e9e",
        "circle-stroke-color": "#d84315",
        "circle-stroke-width": 2,
        "circle-opacity": 0.85,
      },
    });
    addLayerSafe(DROPPED_LABEL_LAYER, {
      id: DROPPED_LABEL_LAYER,
      type: "symbol",
      source: DROPPED_SOURCE,
      layout: {
        "text-field": "x",
        "text-font": SYMBOL_FONT,
        "text-size": 14,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#ffffff",
      },
    });
  }, [map, ready, result, caches]);

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
