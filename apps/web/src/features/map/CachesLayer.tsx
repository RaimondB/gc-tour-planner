// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { createRoot } from "react-dom/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CacheDTO, CacheSummaryDTO, CacheType } from "@gctp/shared/caches";
import {
  clearSolvedCoordinates,
  fetchCacheDetail,
  listCaches,
  markCacheFound,
  unmarkCacheFound,
  type ListCachesParams,
} from "../../lib/api.js";
import { mergeCachesById } from "../planning/halo-caches.js";
import { useMap } from "./MapContext.js";
import { CachePopup } from "./CachePopup.js";
import { PARKING_MIN_ZOOM } from "./parking-zoom.js";
import { isDragGesture } from "./pointer-drag.js";

const CACHES_SOURCE = "gctp-caches";
const CACHES_CIRCLE_LAYER = "gctp-caches-circle";
const CACHES_DISABLED_LABEL_LAYER = "gctp-caches-disabled-label";
const CACHES_SOLVED_BADGE_LAYER = "gctp-caches-solved-badge";
/** addImage id for the canvas-drawn solved checkmark badge. */
const SOLVED_BADGE_ICON = "gctp-solved-check";

/**
 * Draw (once) a small green disc with a white checkmark and register it as a
 * map image, so the solved badge is a real checkmark. We can't use a "✓" text
 * glyph: the style's glyph source (demotiles) only serves basic-Latin ranges,
 * so U+2713 would 404 and render nothing. A canvas icon is glyph-independent.
 * Returns false when no 2D canvas is available (e.g. jsdom in tests) so the
 * caller can skip the badge layer rather than reference a missing image.
 */
function ensureSolvedBadgeIcon(map: maplibregl.Map): boolean {
  if (map.hasImage(SOLVED_BADGE_ICON)) return true;
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const c = size / 2;
  ctx.beginPath();
  ctx.arc(c, c, c - 1.5, 0, Math.PI * 2);
  ctx.fillStyle = "#2e7d32"; // solved green — distinct from the red selection ring
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(size * 0.28, size * 0.52);
  ctx.lineTo(size * 0.44, size * 0.69);
  ctx.lineTo(size * 0.74, size * 0.32);
  ctx.stroke();
  map.addImage(SOLVED_BADGE_ICON, ctx.getImageData(0, 0, size, size), {
    pixelRatio: 2,
  });
  return true;
}
const PARKING_SOURCE = "gctp-parking";
const PARKING_LAYER = "gctp-parking-circle";

const TYPE_COLORS: Record<CacheType, string> = {
  Traditional: "#2e7d32",
  Multi: "#f9a825",
  Mystery: "#1565c0",
  Letterbox: "#6a1b9a",
  EarthCache: "#4e342e",
  Event: "#c62828",
  Virtual: "#00838f",
  Webcam: "#558b2f",
  Wherigo: "#283593",
  CITO: "#2e7d32",
  Other: "#616161",
};

interface CacheProps {
  id: CacheDTO["id"];
  code: string;
  name: string;
  type: CacheType;
  color: string;
  foundByMe: number; // 0/1 — MapLibre filter expressions don't accept booleans
  selected: number; // 0/1 — same MapLibre-filter caveat
  /** 1 when the cache owner has temporarily disabled it (FR-I10). */
  disabled: number;
  /** 1 when `location` is a user-supplied solved/corrected coordinate. */
  solved: number;
  /** FR-SF1 count of `stages` additional waypoints. */
  stageCount: number;
}

const SELECTED_LAYER = "gctp-caches-selected";

export interface SelectedParking {
  point: [number, number];
  ownerCacheId: number;
}

export interface CachesLayerProps {
  /**
   * Canonical, debounced caches-query input owned by App. Used as both the
   * React Query key and the fetch args so this layer and App share one
   * query/cache entry. ALL filters are server-side now (FR-SF10), so this is
   * the single source of what renders — there's no client-side narrowing.
   */
  queryInput: ListCachesParams;
  /**
   * Extra caches to render unconditionally, unioned (by id) with the query
   * result. Used when opening a saved tour: the stored plan's denormalised
   * cache snapshots are shown even though they fall outside the current
   * radius query (or no longer exist in the caches table — FR-P1.3).
   */
  extraCaches?: readonly CacheSummaryDTO[];
  /** Manual selection from the Cluster Lab — drives the highlight ring. */
  selectedCacheIds?: ReadonlySet<number>;
  /** Shift-click toggles a cache in/out of the selection. */
  onSelectionChange?: (next: ReadonlySet<number>) => void;
  /**
   * Clicking a parking marker reports it here so the parent can render the
   * owner-cache link line. `null` clears the selection (used when the
   * caller wants to deselect on outside click).
   */
  onParkingSelect?: (next: SelectedParking | null) => void;
}

export function CachesLayer({
  queryInput,
  extraCaches,
  selectedCacheIds,
  onSelectionChange,
  onParkingSelect,
}: CachesLayerProps): null {
  const { map, ready } = useMap();
  const queryClient = useQueryClient();
  // Screen point of the last pointer-down, used to tell a tap from a pan so a
  // pan that happens to end on a marker doesn't open its popup. See the click
  // handlers below and ./pointer-drag.
  const downPointRef = useRef<{ x: number; y: number } | null>(null);
  const query = useQuery({
    queryKey: ["caches", queryInput],
    queryFn: ({ signal }) => listCaches(queryInput, signal),
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    if (!ready) return;

    // FR-SF2 + FR-SF6 + FR-SF9 are now ALL server-side filters (see
    // CachesQuery): the cache pool the planner clusters must equal the set
    // shown on the map, so every filter lives in one place — the server
    // query — and the map just renders whatever `/caches` returned. No
    // client-side narrowing here anymore.
    // Union the radius query with any explicit extras (saved-tour snapshots),
    // query data winning on id collisions (it carries the full live fields).
    const caches = mergeCachesById(query.data?.caches, extraCaches) ?? [];

    const cachesFeatures = caches.map<
      GeoJSON.Feature<GeoJSON.Point, CacheProps>
    >((c) => ({
      type: "Feature",
      id: c.id,
      geometry: c.location,
      properties: {
        id: c.id,
        code: c.code,
        name: c.name,
        type: c.type,
        color: TYPE_COLORS[c.type] ?? TYPE_COLORS.Other,
        foundByMe: c.foundByMe ? 1 : 0,
        selected: selectedCacheIds?.has(c.id) ? 1 : 0,
        disabled: c.disabled ? 1 : 0,
        solved: c.solved ? 1 : 0,
        stageCount: c.stageCount,
      },
    }));

    const parkingFeatures: GeoJSON.Feature<
      GeoJSON.Point,
      { cacheCode: string; cacheId: number }
    >[] = [];
    for (const c of caches) {
      for (const [lng, lat] of c.parkingPoints) {
        parkingFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lng, lat] },
          properties: { cacheCode: c.code, cacheId: c.id },
        });
      }
    }

    upsertGeoJsonSource(map, CACHES_SOURCE, cachesFeatures);
    upsertGeoJsonSource(map, PARKING_SOURCE, parkingFeatures);

    if (!map.getLayer(CACHES_CIRCLE_LAYER)) {
      map.addLayer({
        id: CACHES_CIRCLE_LAYER,
        type: "circle",
        source: CACHES_SOURCE,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 4, 14, 9],
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          // Two independent dims compose:
          //   * found-by-me → 0.35 (won't disappear, but recedes)
          //   * disabled    → 0.50 (geocaching.com convention for
          //                    temp-disabled). Combining both gives
          //                    ~0.18 which is still visible.
          "circle-opacity": [
            "*",
            ["case", ["==", ["get", "foundByMe"], 1], 0.35, 1],
            ["case", ["==", ["get", "disabled"], 1], 0.5, 1],
          ],
          "circle-stroke-opacity": [
            "*",
            ["case", ["==", ["get", "foundByMe"], 1], 0.35, 1],
            ["case", ["==", ["get", "disabled"], 1], 0.5, 1],
          ],
        },
      });
    }
    // "Z" overlay on disabled caches — matches the visual language
    // geocaching.com uses (zzz = sleeping). Plain ASCII so it
    // renders in every glyph source. Only shown when the marker is
    // big enough for the letter to read (≥ zoom 11).
    if (!map.getLayer(CACHES_DISABLED_LABEL_LAYER)) {
      map.addLayer({
        id: CACHES_DISABLED_LABEL_LAYER,
        type: "symbol",
        source: CACHES_SOURCE,
        minzoom: 11,
        filter: ["==", ["get", "disabled"], 1],
        layout: {
          "text-field": "Z",
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 8, 14, 12],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-anchor": "center",
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "#000000",
          "text-halo-width": 1.4,
        },
      });
    }
    // Solved-coordinate cue: a small green checkmark badge on the upper-right
    // of caches whose plotted location is the user's solved/corrected
    // coordinate (Mystery solution or Multi final) — same idea as the tour
    // stop's green "T" tool badge, distinct from the red Cluster-Lab selection
    // ring. The icon is a canvas image (see ensureSolvedBadgeIcon) so it
    // doesn't depend on the glyph source's symbol range.
    if (
      ensureSolvedBadgeIcon(map) &&
      !map.getLayer(CACHES_SOLVED_BADGE_LAYER)
    ) {
      map.addLayer({
        id: CACHES_SOLVED_BADGE_LAYER,
        type: "symbol",
        source: CACHES_SOURCE,
        filter: ["==", ["get", "solved"], 1],
        layout: {
          "icon-image": SOLVED_BADGE_ICON,
          // upper-right of the marker; offset is in the 24px icon space and
          // then scaled by icon-size.
          "icon-offset": [11, -11],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 14, 0.7],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    }
    if (!map.getLayer(PARKING_LAYER)) {
      map.addLayer({
        id: PARKING_LAYER,
        type: "circle",
        source: PARKING_SOURCE,
        // Cache-owner parking waypoints aren't useful below city-block
        // zoom — they overlap the cache they belong to and just add
        // visual noise. PARKING_MIN_ZOOM is shared with OsmParkingLayer
        // so the two layers always pop in together.
        minzoom: PARKING_MIN_ZOOM,
        paint: {
          // Sized smaller than the cache circle at every zoom so the
          // cache stays the headline feature. Cache layer interpolates
          // z9→4 / z14→9; parking goes PARKING_MIN_ZOOM→3 / +3→6.
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            PARKING_MIN_ZOOM,
            3,
            PARKING_MIN_ZOOM + 3,
            6,
          ],
          "circle-color": "#ffffff",
          "circle-stroke-color": "#1565c0",
          // Stroke also tapers so a small radius doesn't look like a
          // doughnut at city zoom.
          "circle-stroke-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            PARKING_MIN_ZOOM,
            1,
            PARKING_MIN_ZOOM + 3,
            1.8,
          ],
        },
      });
    }
    // Halo ring rendered above the regular caches layer for any cache the
    // user has shift-clicked into the Cluster Lab selection.
    if (!map.getLayer(SELECTED_LAYER)) {
      map.addLayer({
        id: SELECTED_LAYER,
        type: "circle",
        source: CACHES_SOURCE,
        filter: ["==", ["get", "selected"], 1],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 8, 14, 14],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#ff1744",
          "circle-stroke-width": 3,
        },
      });
    }

    // Some MapLibre builds don't schedule a redraw after addLayer + setData on
    // an otherwise-idle map, so a fresh result (or the first render after the
    // style loads) can leave markers unpainted until the next interaction —
    // the "caches only appear after I click the map" symptom. Force a repaint,
    // matching TourLayer / MapView.
    map.triggerRepaint();

    return undefined;
  }, [map, ready, query.data, extraCaches, selectedCacheIds]);

  // Click handler — bound once. Reads from current source data, not the
  // closure, so it stays correct as the query refreshes.
  useEffect(() => {
    if (!ready) return;
    const handler = (
      e: maplibregl.MapMouseEvent & {
        features?: maplibregl.MapGeoJSONFeature[];
      },
    ) => {
      // Ignore clicks that are really the tail of a pan — under the reticle
      // model the user pans over caches constantly to reposition the area.
      if (isDragGesture(downPointRef.current, e.point)) return;
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as unknown as CacheProps;
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;

      // Modifier-click → toggle into the Cluster Lab selection set instead
      // of opening the popup. Shift on Linux/Windows; ⌘ or Ctrl on macOS
      // (browsers sometimes hijack plain shift-click for text selection).
      const me = e.originalEvent;
      if (
        onSelectionChange &&
        (me.shiftKey || me.ctrlKey || me.metaKey || me.altKey)
      ) {
        // Stop other layer handlers (and MapView's pick-center) from also
        // running on this click.
        me.preventDefault();
        // Feature properties survive a JSON round-trip through MapLibre, so
        // coerce id to number defensively in case the source-data hop ever
        // changes that.
        const id = Number(props.id);
        const next = new Set(selectedCacheIds ?? []);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        // eslint-disable-next-line no-console
        console.debug(
          "[cluster-lab] toggle",
          id,
          "→ selection size",
          next.size,
        );
        onSelectionChange(next);
        return;
      }

      const container = document.createElement("div");
      const root = createRoot(container);

      const popup = new maplibregl.Popup({ closeButton: true })
        .setLngLat([lng, lat])
        .setDOMContent(container)
        .addTo(map);

      const id = Number(props.id);
      // The lean /caches list omits popup-only fields (difficulty, terrain,
      // attributes, hints); fetch them lazily on open. Header fields come from
      // the summary props so the popup paints instantly, then detail fills in.
      let detail: CacheDTO | null = null;
      let found = props.foundByMe === 1;
      let solved = props.solved === 1;
      const renderPopup = () => {
        root.render(
          <CachePopup
            code={props.code}
            name={props.name}
            type={props.type}
            difficulty={detail?.difficulty ?? null}
            terrain={detail?.terrain ?? null}
            foundByMe={found}
            attributeIds={detail?.attributeIds ?? []}
            descriptionHints={detail?.descriptionHints ?? []}
            stageCount={props.stageCount}
            solved={solved}
            loadingDetail={detail === null}
            onToggleFound={async () => {
              try {
                if (found) await unmarkCacheFound(id);
                else await markCacheFound(id);
                found = !found;
                renderPopup();
                void queryClient.invalidateQueries({ queryKey: ["caches"] });
              } catch (err) {
                console.error("toggle found failed", err);
              }
            }}
            onClearSolved={
              solved
                ? async () => {
                    try {
                      const { cleared } = await clearSolvedCoordinates(id);
                      if (cleared) solved = false;
                      renderPopup();
                      // The cache's location reverted — refetch so the marker
                      // jumps back to the posted coord.
                      void queryClient.invalidateQueries({
                        queryKey: ["caches"],
                      });
                      void queryClient.invalidateQueries({
                        queryKey: ["cache-detail", id],
                      });
                    } catch (err) {
                      console.error("clear solved failed", err);
                    }
                  }
                : undefined
            }
          />,
        );
      };

      renderPopup();
      void queryClient
        .fetchQuery({
          queryKey: ["cache-detail", id],
          queryFn: () => fetchCacheDetail(id),
          gcTime: 60_000,
        })
        .then((d) => {
          detail = d;
          renderPopup();
          // The card just grew (chips). We mutated its DOM via React without
          // telling MapLibre, so its anchor transform was rounded for the old
          // size and the resized card can land on a sub-pixel → blurry text.
          // Re-set the position after React commits (next frame) so MapLibre
          // re-measures and re-rounds the transform for the final size.
          requestAnimationFrame(() => {
            if (popup.isOpen()) popup.setLngLat([lng, lat]);
          });
        })
        .catch((err) => {
          // Leave the header-only popup; detail just won't fill in.
          console.error("cache detail fetch failed", err);
        });

      popup.on("close", () => {
        // Defer to next microtask so React doesn't unmount mid-event.
        queueMicrotask(() => root.unmount());
      });
    };
    const enter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
    };
    const parkingHandler = (
      e: maplibregl.MapMouseEvent & {
        features?: maplibregl.MapGeoJSONFeature[];
      },
    ) => {
      if (isDragGesture(downPointRef.current, e.point)) return;
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as { cacheCode?: string; cacheId?: number };
      const code = props.cacheCode ?? "?";
      const cacheId = props.cacheId;
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      new maplibregl.Popup({ closeButton: true })
        .setLngLat([lng, lat])
        .setHTML(
          `<div style="font:13px system-ui;padding:2px 4px">Parking for <strong>${code}</strong></div>`,
        )
        .addTo(map);
      // Drive the owner-link layer — every click pins to the latest
      // parking. Clearing happens via the dedicated layer's outside-click
      // handler, keeping this handler simple.
      if (typeof cacheId === "number" && onParkingSelect) {
        onParkingSelect({ point: [lng, lat], ownerCacheId: cacheId });
      }
    };
    // Track the pointer-down screen point map-wide so the layer click handlers
    // can distinguish a tap from a pan that ends on a marker.
    const rememberDown = (
      e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent,
    ) => {
      downPointRef.current = { x: e.point.x, y: e.point.y };
    };
    map.on("mousedown", rememberDown);
    map.on("touchstart", rememberDown);
    map.on("click", CACHES_CIRCLE_LAYER, handler);
    map.on("mouseenter", CACHES_CIRCLE_LAYER, enter);
    map.on("mouseleave", CACHES_CIRCLE_LAYER, leave);
    map.on("click", PARKING_LAYER, parkingHandler);
    map.on("mouseenter", PARKING_LAYER, enter);
    map.on("mouseleave", PARKING_LAYER, leave);
    return () => {
      map.off("mousedown", rememberDown);
      map.off("touchstart", rememberDown);
      map.off("click", CACHES_CIRCLE_LAYER, handler);
      map.off("mouseenter", CACHES_CIRCLE_LAYER, enter);
      map.off("mouseleave", CACHES_CIRCLE_LAYER, leave);
      map.off("click", PARKING_LAYER, parkingHandler);
      map.off("mouseenter", PARKING_LAYER, enter);
      map.off("mouseleave", PARKING_LAYER, leave);
    };
  }, [
    map,
    ready,
    queryClient,
    selectedCacheIds,
    onSelectionChange,
    onParkingSelect,
  ]);

  return null;
}

function upsertGeoJsonSource(
  map: maplibregl.Map,
  id: string,
  features: GeoJSON.Feature[],
): void {
  const collection: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features,
  };
  const existing = map.getSource(id);
  if (existing && "setData" in existing) {
    (existing as maplibregl.GeoJSONSource).setData(collection);
    return;
  }
  map.addSource(id, { type: "geojson", data: collection });
}
