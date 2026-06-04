// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import maplibregl from "maplibre-gl";
import { createRoot } from "react-dom/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CacheDTO, CacheType } from "@gctp/shared/caches";
import { classifyMulti } from "@gctp/shared/caches";
import {
  fetchCacheDetail,
  listCaches,
  markCacheFound,
  unmarkCacheFound,
  type ListCachesParams,
} from "../../lib/api.js";
import type { SearchParams } from "../../lib/search-params.js";
import { useMap } from "./MapContext.js";
import { CachePopup } from "./CachePopup.js";
import { PARKING_MIN_ZOOM } from "./parking-zoom.js";

const CACHES_SOURCE = "gctp-caches";
const CACHES_CIRCLE_LAYER = "gctp-caches-circle";
const CACHES_DISABLED_LABEL_LAYER = "gctp-caches-disabled-label";
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
  /** FR-SF1 count of `stages` additional waypoints. */
  stageCount: number;
}

const SELECTED_LAYER = "gctp-caches-selected";

export interface SelectedParking {
  point: [number, number];
  ownerCacheId: number;
}

export interface CachesLayerProps {
  params: SearchParams;
  /**
   * Canonical, debounced caches-query input owned by App (server-relevant
   * params only). Used as both the React Query key and the fetch args so this
   * layer and App share one query/cache entry. `params` is still used for the
   * client-side-only filters (hideToolCaches, multiSubtype) so those stay
   * instant and never refetch.
   */
  queryInput: ListCachesParams;
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
  params,
  queryInput,
  selectedCacheIds,
  onSelectionChange,
  onParkingSelect,
}: CachesLayerProps): null {
  const { map, ready } = useMap();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["caches", queryInput],
    queryFn: ({ signal }) => listCaches(queryInput, signal),
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    if (!ready) return;

    const rawCaches = query.data?.caches ?? [];

    // FR-SF2 + FR-SF6: client-side filters applied after fetch so the
    // user can toggle without a server round-trip. The server still
    // does the heavy spatial + type filtering; we only narrow further.
    const caches = rawCaches.filter((c) => {
      // `requiresTool` is computed server-side (= hasToolRequirement over the
      // attribute ids + description hints) so this stays an instant client
      // filter without the lean list shipping those arrays.
      if (params.hideToolCaches && c.requiresTool) return false;
      if (params.multiSubtype !== "all" && c.type === "Multi") {
        // classifyMulti distinguishes field-puzzle (stages=0) from
        // mini (1-2) and full (3+). Bucketing 0-stage Multis as
        // mini would be wrong — they're usually field-puzzle
        // multis where you derive the next coord on-site.
        if (classifyMulti(c.stageCount) !== params.multiSubtype) return false;
      }
      return true;
    });

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

    return undefined;
    // FR-SF2 + FR-SF6: re-run when the client-side filter toggles
    // change, even if query.data didn't (e.g. user unchecks
    // hideToolCaches with the same fetch in the cache).
  }, [
    map,
    ready,
    query.data,
    selectedCacheIds,
    params.hideToolCaches,
    params.multiSubtype,
  ]);

  // Click handler — bound once. Reads from current source data, not the
  // closure, so it stays correct as the query refreshes.
  useEffect(() => {
    if (!ready) return;
    const handler = (
      e: maplibregl.MapMouseEvent & {
        features?: maplibregl.MapGeoJSONFeature[];
      },
    ) => {
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
    map.on("click", CACHES_CIRCLE_LAYER, handler);
    map.on("mouseenter", CACHES_CIRCLE_LAYER, enter);
    map.on("mouseleave", CACHES_CIRCLE_LAYER, leave);
    map.on("click", PARKING_LAYER, parkingHandler);
    map.on("mouseenter", PARKING_LAYER, enter);
    map.on("mouseleave", PARKING_LAYER, leave);
    return () => {
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
