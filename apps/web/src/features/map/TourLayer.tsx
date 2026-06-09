// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import type { CacheSummaryDTO } from "@gctp/shared/caches";
import type { PlanResult } from "@gctp/shared/tours";
import { type LegPicks, resolvePick } from "../../lib/persistent-state.js";
import { useMap } from "./MapContext.js";

const TOUR_SOURCE = "gctp-tour";
const TOUR_LAYER = "gctp-tour-line";
const TOUR_HALO_LAYER = "gctp-tour-halo";
const TOUR_ARROW_LAYER = "gctp-tour-arrows";
/**
 * Invisible wide-stroke hit-layer, only added when edit mode is on.
 * Lives at the top of the stack so clicks land before bubbling down to
 * the basemap. Each feature carries `legIndex` so the click handler
 * can report which leg was hit.
 */
const TOUR_HIT_LAYER = "gctp-tour-hit";
const PARKING_SOURCE = "gctp-tour-parking";
const PARKING_LAYER = "gctp-tour-parking-circle";
const PARKING_LABEL_LAYER = "gctp-tour-parking-label";
const PARKING_LEADER_SOURCE = "gctp-tour-parking-leader";
const PARKING_LEADER_LAYER = "gctp-tour-parking-leader-line";
// When the parking marker lands within this many screen pixels of a stop the
// two ~11–12px circles overlap; offset the parking marker by OFFSET_PX and draw
// a short leader line back to its true location so both stay legible.
const COLLIDE_PX = 22;
const OFFSET_PX: [number, number] = [14, -14];
const STOP_SOURCE = "gctp-tour-stops";
const STOP_CIRCLE_LAYER = "gctp-tour-stops-circle";
const STOP_LABEL_LAYER = "gctp-tour-stops-label";
/**
 * FR-SF5: small "T" badge rendered on the upper-right of a stop
 * circle when the cache needs equipment (`hasToolRequirement` true).
 * Filtered by feature property so a single source feeds both the
 * numbered circle and the conditional badge.
 */
const STOP_TOOL_LAYER = "gctp-tour-stops-tool";
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
  editMode = false,
  legPicks,
  selectedLegIndex = null,
  onLegSelect,
}: {
  result: PlanResult | null;
  caches: readonly CacheSummaryDTO[] | undefined;
  /** When true, splits the tour into per-leg clickable features. */
  editMode?: boolean;
  /**
   * Map of legIndex → user-picked alternative index. Overrides the
   * planner-picked geometry when set. Unset legs keep the planner pick.
   */
  legPicks?: Readonly<LegPicks>;
  /** Index of the leg the panel is editing (highlighted on the map). */
  selectedLegIndex?: number | null;
  /** Fires when the user clicks a leg in edit mode. `null` clears. */
  onLegSelect?: (legIndex: number | null) => void;
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

    // Build the tour FC per-leg when leg breakdown is available. This
    // serves two purposes simultaneously:
    //  1. Edit mode can attach a layer-bound click handler keyed on
    //     `legIndex` — one click → exactly one leg identified.
    //  2. `legPicks` can override individual legs' geometry without
    //     re-running the planner.
    // For strategies that don't populate `legs` (the solver path) we
    // fall back to the single concatenated polyline.
    const legs = result?.legs ?? [];
    const tourFc: GeoJSON.FeatureCollection = result
      ? legs.length > 0
        ? {
            type: "FeatureCollection",
            features: legs.map((leg) => {
              const r = resolvePick(leg, legPicks?.[leg.index]);
              return {
                type: "Feature",
                geometry: r.geometry,
                properties: {
                  legIndex: leg.index,
                  selected: leg.index === selectedLegIndex ? 1 : 0,
                },
              };
            }),
          }
        : {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: result.polyline,
                properties: { legIndex: -1, selected: 0 },
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
              properties: {
                type: result.parking.type,
                // 1 → no feasible parking found; the planner started at the
                // cluster centroid. Drives the distinct red "P?" marker.
                fallback: result.parking.fallback ? 1 : 0,
              },
            },
          ],
        }
      : { type: "FeatureCollection", features: [] };

    // Numbered visit-order stops. Look up each ordered cache's coordinates
    // from the caches list (same array CachesLayer paints) — without this
    // we'd need a separate fetch just to get coordinates the page already
    // has. If `caches` hasn't loaded yet we render an empty FC and the
    // layer simply has nothing to draw.
    const cacheById = new Map<number, CacheSummaryDTO>();
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
                  // FR-SF5 0/1 flag drives the STOP_TOOL_LAYER filter.
                  // `requiresTool` is computed server-side (= hasToolRequirement).
                  hasTool: cache.requiresTool ? 1 : 0,
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
    // Leader line is populated by the collision effect below; start empty.
    upsertGeoJsonSource(map, PARKING_LEADER_SOURCE, {
      type: "FeatureCollection",
      features: [],
    });
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
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 5, 14, 10],
        "line-opacity": 0.85,
      },
    });
    addLayerSafe(TOUR_LAYER, {
      id: TOUR_LAYER,
      type: "line",
      source: TOUR_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        // Selected leg renders amber so the user sees what the panel
        // is currently editing without having to track the leg number.
        "line-color": [
          "case",
          ["==", ["get", "selected"], 1],
          "#ffb300",
          "#d84315",
        ],
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.5, 14, 5],
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
    // Leader line, added before the parking circle so it draws beneath it.
    addLayerSafe(PARKING_LEADER_LAYER, {
      id: PARKING_LEADER_LAYER,
      type: "line",
      source: PARKING_LEADER_SOURCE,
      paint: {
        "line-color": "#607d8b",
        "line-width": 1.5,
        "line-opacity": 0.9,
      },
    });
    addLayerSafe(PARKING_LAYER, {
      id: PARKING_LAYER,
      type: "circle",
      source: PARKING_SOURCE,
      paint: {
        "circle-radius": 11,
        // Red when the planner found no feasible parking and fell back to the
        // cluster centroid; the usual blue otherwise.
        "circle-color": [
          "case",
          ["==", ["get", "fallback"], 1],
          "#b71c1c",
          "#1565c0",
        ],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
    addLayerSafe(PARKING_LABEL_LAYER, {
      id: PARKING_LABEL_LAYER,
      type: "symbol",
      source: PARKING_SOURCE,
      layout: {
        // "P?" signals "no parking found here" without needing a banner.
        "text-field": ["case", ["==", ["get", "fallback"], 1], "P?", "P"],
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
    // FR-SF5: small "T" badge in the upper-right of a stop circle
    // when that cache requires equipment. Letter "T" instead of an
    // emoji wrench so it renders in the bundled Noto Sans Bold (no
    // emoji glyph would render as a fallback box). Green halo
    // distinguishes from the red stop circle.
    addLayerSafe(STOP_TOOL_LAYER, {
      id: STOP_TOOL_LAYER,
      type: "symbol",
      source: STOP_SOURCE,
      filter: ["==", ["get", "hasTool"], 1],
      layout: {
        "text-field": "T",
        "text-font": SYMBOL_FONT,
        "text-size": 11,
        "text-offset": [0.9, -0.9],
        "text-anchor": "center",
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#1b5e20",
        "text-halo-width": 2,
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

    // Hit layer for edit-mode clicks. Wide invisible stroke so the
    // click target is forgiving even at low zoom. Added/removed based
    // on `editMode` so the cursor doesn't show as pointer when edits
    // are disabled.
    if (editMode && legs.length > 0) {
      addLayerSafe(TOUR_HIT_LAYER, {
        id: TOUR_HIT_LAYER,
        type: "line",
        source: TOUR_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#000000",
          "line-opacity": 0,
          "line-width": 14,
        },
      });
    } else if (map.getLayer(TOUR_HIT_LAYER)) {
      map.removeLayer(TOUR_HIT_LAYER);
    }

    // Some MapLibre builds don't schedule a redraw after addLayer+setData
    // when the map is in a quiescent state — the layer is in the style
    // but the canvas keeps showing the pre-update frame until the next
    // user interaction (a click, a pan, anything that calls
    // map.update()). Force the next frame ourselves so the numbered
    // visit pins + dropped-cache badges appear immediately after the
    // plan response lands.
    map.triggerRepaint();
  }, [map, ready, result, caches, editMode, legPicks, selectedLegIndex]);

  // Keep the parking "P" marker legible when it sits on top of a stop: offset
  // it a few pixels and draw a short leader line back to its true location.
  // Pixel-based, so it recomputes on zoom/move. The constant pixel translate is
  // zoom-invariant; only the leader's unprojected endpoint needs refreshing.
  useEffect(() => {
    if (!ready) return;
    const parking = result?.parking.point.coordinates as
      | [number, number]
      | undefined;
    const byId = new Map<number, CacheSummaryDTO>();
    for (const c of caches ?? []) byId.set(c.id, c);

    const clearOffset = () => {
      if (map.getLayer(PARKING_LAYER))
        map.setPaintProperty(PARKING_LAYER, "circle-translate", [0, 0]);
      if (map.getLayer(PARKING_LABEL_LAYER))
        map.setPaintProperty(PARKING_LABEL_LAYER, "text-translate", [0, 0]);
      const src = map.getSource(PARKING_LEADER_SOURCE);
      if (src && "setData" in src)
        (src as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: [],
        });
    };

    const recompute = () => {
      if (!parking || !result) {
        clearOffset();
        return;
      }
      const pPx = map.project(parking);
      let nearest: { coord: [number, number]; distPx: number } | null = null;
      for (const id of result.orderedCacheIds) {
        const cache = byId.get(id);
        if (!cache) continue;
        const coord = cache.location.coordinates as [number, number];
        const sPx = map.project(coord);
        const d = Math.hypot(sPx.x - pPx.x, sPx.y - pPx.y);
        if (!nearest || d < nearest.distPx) nearest = { coord, distPx: d };
      }
      if (!nearest || nearest.distPx > COLLIDE_PX) {
        clearOffset();
        return;
      }
      if (map.getLayer(PARKING_LAYER))
        map.setPaintProperty(PARKING_LAYER, "circle-translate", OFFSET_PX);
      if (map.getLayer(PARKING_LABEL_LAYER))
        map.setPaintProperty(PARKING_LABEL_LAYER, "text-translate", OFFSET_PX);
      const tip = map.unproject([pPx.x + OFFSET_PX[0], pPx.y + OFFSET_PX[1]]);
      const src = map.getSource(PARKING_LEADER_SOURCE);
      if (src && "setData" in src)
        (src as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: [nearest.coord, [tip.lng, tip.lat]],
              },
            },
          ],
        });
    };

    recompute();
    map.on("move", recompute);
    map.on("zoom", recompute);
    return () => {
      map.off("move", recompute);
      map.off("zoom", recompute);
    };
  }, [map, ready, result, caches]);

  // Edit-mode click handler. Bound separately so the layer-create
  // effect can re-run without rebinding the listener. `useMap`'s `ready`
  // gate plus the layer-existence guard keep it resilient to lifecycle
  // races (hit layer removed when editMode flips off).
  useEffect(() => {
    if (!ready) return;
    if (!editMode || !onLegSelect) return;
    const onClick = (
      e: maplibregl.MapMouseEvent & {
        features?: maplibregl.MapGeoJSONFeature[];
      },
    ) => {
      const f = e.features?.[0];
      if (!f) return;
      const idx = (f.properties as { legIndex?: number }).legIndex;
      if (typeof idx === "number" && idx >= 0) {
        onLegSelect(idx);
      }
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    map.on("click", TOUR_HIT_LAYER, onClick);
    map.on("mouseenter", TOUR_HIT_LAYER, onEnter);
    map.on("mouseleave", TOUR_HIT_LAYER, onLeave);
    return () => {
      map.off("click", TOUR_HIT_LAYER, onClick);
      map.off("mouseenter", TOUR_HIT_LAYER, onEnter);
      map.off("mouseleave", TOUR_HIT_LAYER, onLeave);
      map.getCanvas().style.cursor = "";
    };
  }, [map, ready, editMode, onLegSelect]);

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
