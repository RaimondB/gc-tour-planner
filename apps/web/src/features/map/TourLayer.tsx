// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import type { CacheSummaryDTO } from "@gctp/shared/caches";
import type { PlanResult } from "@gctp/shared/tours";
import { type LegPicks, resolvePick } from "../../lib/persistent-state.js";
import { collapseByProximity } from "./marker-collapse.js";
import {
  TYPE_COLORS,
  TYPE_GLYPH,
  TOUR_ACCENT,
  ensureMarkerImage,
  markerImageId,
  ensureToolBadgeIcon,
  TOOL_BADGE_ICON,
  ensureExcludedRingIcon,
  EXCLUDED_RING_ICON,
  cornerIconOffset,
  cornerTextOffset,
} from "./marker-style.js";
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
const STOP_AL_ICON_LAYER = "gctp-tour-stops-al-icon";
const STOP_LABEL_LAYER = "gctp-tour-stops-label";
// Collapsed-stop overlay: stops whose markers overlap on screen at the current
// zoom merge into one "stacked" node (shadow + disc + range/count label) until
// the user zooms in far enough that they separate. Pixel-based (recomputed on
// zoom), so truly-coincident stops stay merged at every zoom while merely-near
// ones pop apart as you zoom. Mirrors the parking-collision pattern below.
const STOP_COLLAPSED_SOURCE = "gctp-tour-stops-collapsed";
const STOP_COLLAPSED_SHADOW_LAYER = "gctp-tour-stops-collapsed-shadow";
const STOP_COLLAPSED_CIRCLE_LAYER = "gctp-tour-stops-collapsed-circle";
const STOP_COLLAPSED_LABEL_LAYER = "gctp-tour-stops-collapsed-label";
/** Centre-to-centre screen distance under which two ~12px-radius stops overlap. */
const COLLAPSE_PX = 20;
/** Adventure Lab stop colour (shared kind colour). */
const AL_STOP_COLOR = TYPE_COLORS["Adventure Lab"];
/** Default routed-stop colour (tour accent). */
const STOP_COLOR = TOUR_ACCENT;
/**
 * FR-SF5: a wrench badge in the reserved TR corner of a stop when the cache
 * needs equipment. An ICON (not a "T" letter) — a letter would collide with the
 * Traditional type glyph (status = icons, identity = letters; ADR-0035).
 */
const STOP_TOOL_LAYER = "gctp-tour-stops-tool";
// Demoted identity badge in the reserved BR corner of a routed stop (ADR-0035):
// the centre shows the tour visit order for EVERY stop, so the cache's identity
// (its type letter, or "S{n}"/"L{n}" for an AL stage) moves to this corner.
const STOP_IDENTITY_LAYER = "gctp-tour-stops-identity";
/** Tour AL stops are squircles like every AL marker — icon-size for radius ~12. */
const STOP_AL_ICON = markerImageId("al", AL_STOP_COLOR);
const STOP_AL_ICON_SIZE = 1.6;
const DROPPED_SOURCE = "gctp-tour-dropped";
const DROPPED_RING_LAYER = "gctp-tour-dropped-ring";
const DROPPED_CIRCLE_LAYER = "gctp-tour-dropped-circle";
const DROPPED_LABEL_LAYER = "gctp-tour-dropped-label";
/** Dropped candidates recede behind routed stops (excluded-but-recognisable). */
const DROPPED_OPACITY = 0.55;

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

    // Numbered visit-order stops are built + grouped (co-located collapse) in
    // the zoom-reactive effect below; here we just ensure the two stop sources
    // exist so the layers can attach. Look up coordinates from the caches list
    // (same array CachesLayer paints) — no separate fetch needed.
    const cacheById = new Map<number, CacheSummaryDTO>();
    for (const c of caches ?? []) cacheById.set(c.id, c);

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
              const isAL = cache.type === "Adventure Lab";
              const stageSequence = cache.stageSequence ?? 0;
              return {
                type: "Feature",
                geometry: cache.location,
                properties: {
                  code: cache.code,
                  // Keep type colour + identity (ADR-0035): a dropped candidate
                  // stays recognisable; the dashed ring + dim mark it excluded.
                  color: TYPE_COLORS[cache.type] ?? TYPE_COLORS.Other,
                  identityText: isAL
                    ? `${cache.adventureSequential ? "L" : "S"}${stageSequence}`
                    : (TYPE_GLYPH[cache.type] ?? TYPE_GLYPH.Other),
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
    // Seed empty; the collapse effect populates STOP_SOURCE (singletons) and
    // STOP_COLLAPSED_SOURCE (merged groups) based on the current zoom.
    if (!map.getSource(STOP_SOURCE))
      upsertGeoJsonSource(map, STOP_SOURCE, {
        type: "FeatureCollection",
        features: [],
      });
    if (!map.getSource(STOP_COLLAPSED_SOURCE))
      upsertGeoJsonSource(map, STOP_COLLAPSED_SOURCE, {
        type: "FeatureCollection",
        features: [],
      });
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
    // Routed-stop base marker (ADR-0035): the cache's own SHAPE + type COLOUR,
    // bigger than the caches-layer marker so the visit order is readable without
    // zooming. A circle for regular caches, a purple squircle for AL stages —
    // the same kind shapes used everywhere. CachesLayer hides the underlying
    // cache (tour-owned), so this is the single authority for routed stops.
    const stopAlIconOk = ensureMarkerImage(map, "al", AL_STOP_COLOR);
    addLayerSafe(STOP_CIRCLE_LAYER, {
      id: STOP_CIRCLE_LAYER,
      type: "circle",
      source: STOP_SOURCE,
      // Non-AL stops; AL stops render as the squircle icon below.
      filter: ["==", ["get", "stageSequence"], 0],
      paint: {
        "circle-radius": 12,
        "circle-color": ["get", "color"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
    if (stopAlIconOk) {
      addLayerSafe(STOP_AL_ICON_LAYER, {
        id: STOP_AL_ICON_LAYER,
        type: "symbol",
        source: STOP_SOURCE,
        filter: [">", ["get", "stageSequence"], 0],
        layout: {
          "icon-image": STOP_AL_ICON,
          "icon-size": STOP_AL_ICON_SIZE,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    } else {
      // No-canvas fallback (jsdom): a purple circle so AL stops still appear.
      addLayerSafe(STOP_AL_ICON_LAYER, {
        id: STOP_AL_ICON_LAYER,
        type: "circle",
        source: STOP_SOURCE,
        filter: [">", ["get", "stageSequence"], 0],
        paint: {
          "circle-radius": 12,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
    }
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
    // FR-SF5: a wrench badge in the reserved TR corner when the cache needs
    // equipment. An icon (not "T") so it can't be read as the Traditional type
    // glyph (status = icons, identity = letters). Canvas image, like CachesLayer.
    if (ensureToolBadgeIcon(map)) {
      addLayerSafe(STOP_TOOL_LAYER, {
        id: STOP_TOOL_LAYER,
        type: "symbol",
        source: STOP_SOURCE,
        filter: ["==", ["get", "hasTool"], 1],
        layout: {
          "icon-image": TOOL_BADGE_ICON,
          "icon-offset": cornerIconOffset("TR"),
          "icon-size": 0.7,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    }
    // Demoted identity badge in the reserved BR corner (ADR-0035): the centre of
    // every stop is the tour visit order, so the cache's identity moves here —
    // the type letter for a regular cache, "S{n}"/"L{n}" for an AL stage. Haloed
    // by the stop's own type colour so the white glyph reads on any basemap.
    addLayerSafe(STOP_IDENTITY_LAYER, {
      id: STOP_IDENTITY_LAYER,
      type: "symbol",
      source: STOP_SOURCE,
      layout: {
        "text-field": ["get", "identityText"],
        "text-font": SYMBOL_FONT,
        "text-size": 9,
        "text-offset": cornerTextOffset("BR"),
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": ["get", "color"],
        "text-halo-width": 2,
      },
    });
    // Collapsed stop node — drawn when several stops overlap on screen. A
    // translucent offset "shadow" disc behind the main disc gives a stacked
    // look (the visual indication that it's a group), and the label shows the
    // covered stop range (e.g. "3–7") or "×N" when non-contiguous.
    addLayerSafe(STOP_COLLAPSED_SHADOW_LAYER, {
      id: STOP_COLLAPSED_SHADOW_LAYER,
      type: "circle",
      source: STOP_COLLAPSED_SOURCE,
      paint: {
        "circle-radius": 13,
        "circle-color": ["get", "color"],
        "circle-opacity": 0.45,
        "circle-translate": [4, 4],
      },
    });
    addLayerSafe(STOP_COLLAPSED_CIRCLE_LAYER, {
      id: STOP_COLLAPSED_CIRCLE_LAYER,
      type: "circle",
      source: STOP_COLLAPSED_SOURCE,
      paint: {
        "circle-radius": 14,
        "circle-color": ["get", "color"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
    addLayerSafe(STOP_COLLAPSED_LABEL_LAYER, {
      id: STOP_COLLAPSED_LABEL_LAYER,
      type: "symbol",
      source: STOP_COLLAPSED_SOURCE,
      layout: {
        "text-field": ["get", "label"],
        "text-font": SYMBOL_FONT,
        "text-size": 12,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#ffffff",
      },
    });
    // Trimmed-by-planner caches (ADR-0035). They KEEP their type colour and
    // identity (so you can still see what you skipped), but recede via reduced
    // opacity and are marked excluded by a DASHED red ring (dashed-vs-solid is
    // the colour-blind-safe channel). No visit-order number — the centre shows
    // the identity letter / stage-id, which is how you tell a dropped candidate
    // from a routed stop.
    addLayerSafe(DROPPED_CIRCLE_LAYER, {
      id: DROPPED_CIRCLE_LAYER,
      type: "circle",
      source: DROPPED_SOURCE,
      paint: {
        "circle-radius": 11,
        "circle-color": ["get", "color"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
        "circle-opacity": DROPPED_OPACITY,
        "circle-stroke-opacity": DROPPED_OPACITY,
      },
    });
    if (ensureExcludedRingIcon(map)) {
      addLayerSafe(DROPPED_RING_LAYER, {
        id: DROPPED_RING_LAYER,
        type: "symbol",
        source: DROPPED_SOURCE,
        layout: {
          "icon-image": EXCLUDED_RING_ICON,
          "icon-size": 0.7,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    }
    addLayerSafe(DROPPED_LABEL_LAYER, {
      id: DROPPED_LABEL_LAYER,
      type: "symbol",
      source: DROPPED_SOURCE,
      layout: {
        "text-field": ["get", "identityText"],
        "text-font": SYMBOL_FONT,
        "text-size": 11,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": ["get", "color"],
        "text-halo-width": 1.4,
        "text-opacity": DROPPED_OPACITY,
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

  // Co-located stop collapse. Stops whose markers overlap on screen at the
  // current zoom merge into a single stacked node; they pop apart as the user
  // zooms in (recomputed on every zoom). Pixel-based so truly-coincident stops
  // (e.g. an adventure's stages at one spot) stay merged at every zoom, while
  // merely-near stops separate. Numbered singletons live in STOP_SOURCE;
  // merged groups in STOP_COLLAPSED_SOURCE.
  useEffect(() => {
    if (!ready) return;
    const byId = new Map<number, CacheSummaryDTO>();
    for (const c of caches ?? []) byId.set(c.id, c);
    interface Stop {
      order: number;
      code: string;
      hasTool: number;
      isAL: boolean;
      /** AL stage number (0 for non-AL). */
      stageSequence: number;
      /** Per-type fill colour, PRESERVED in the tour (ADR-0035) — not blanket red. */
      color: string;
      /** Demoted identity for the BR corner badge: type letter / "S{n}"/"L{n}". */
      identityText: string;
      coord: [number, number];
    }
    const stops: Stop[] = result
      ? result.orderedCacheIds
          .map<Stop | null>((id, i) => {
            const cache = byId.get(id);
            if (!cache) return null;
            const isAL = cache.type === "Adventure Lab";
            const stageSequence = cache.stageSequence ?? 0;
            return {
              order: i + 1,
              code: cache.code,
              hasTool: cache.requiresTool ? 1 : 0,
              isAL,
              stageSequence,
              color: TYPE_COLORS[cache.type] ?? TYPE_COLORS.Other,
              identityText: isAL
                ? `${cache.adventureSequential ? "L" : "S"}${stageSequence}`
                : (TYPE_GLYPH[cache.type] ?? TYPE_GLYPH.Other),
              coord: cache.location.coordinates as [number, number],
            };
          })
          .filter((s): s is Stop => s !== null)
      : [];

    const setData = (id: string, features: GeoJSON.Feature[]): void => {
      const src = map.getSource(id);
      if (src && "setData" in src)
        (src as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features,
        });
    };

    const recompute = (): void => {
      if (stops.length === 0) {
        setData(STOP_SOURCE, []);
        setData(STOP_COLLAPSED_SOURCE, []);
        return;
      }
      // Unified pixel-proximity collapse (shared with CachesLayer's AL pins):
      // singletons render as numbered stops, merged groups as one stacked node
      // with a contiguous-range or ×count label.
      const { singles, groups } = collapseByProximity(
        stops.map((s) => ({ lng: s.coord[0], lat: s.coord[1], item: s })),
        (lngLat) => map.project(lngLat),
        { thresholdPx: COLLAPSE_PX, order: (s) => s.order },
      );
      const singleFeatures: GeoJSON.Feature[] = singles.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: s.coord },
        properties: {
          order: s.order,
          code: s.code,
          hasTool: s.hasTool,
          stageSequence: s.stageSequence,
          color: s.color,
          identityText: s.identityText,
        },
      }));
      const groupFeatures: GeoJSON.Feature[] = groups.map((g) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: g.center },
        properties: {
          count: g.count,
          label: g.label,
          color: g.members.every((m) => m.isAL) ? AL_STOP_COLOR : STOP_COLOR,
        },
      }));
      setData(STOP_SOURCE, singleFeatures);
      setData(STOP_COLLAPSED_SOURCE, groupFeatures);
      map.triggerRepaint();
    };

    recompute();
    map.on("zoom", recompute);
    return () => {
      map.off("zoom", recompute);
    };
  }, [map, ready, result, caches]);

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
