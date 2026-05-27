// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import maplibregl from "maplibre-gl";
import { createRoot } from "react-dom/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CacheDTO, CacheType } from "@gctp/shared/caches";
import { listCaches, markCacheFound, unmarkCacheFound } from "../../lib/api.js";
import type { SearchParams } from "../../lib/search-params.js";
import { useMap } from "./MapContext.js";
import { CachePopup } from "./CachePopup.js";

const CACHES_SOURCE = "gctp-caches";
const CACHES_CIRCLE_LAYER = "gctp-caches-circle";
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
  difficulty: number | null;
  terrain: number | null;
  color: string;
  foundByMe: number; // 0/1 — MapLibre filter expressions don't accept booleans
  selected: number; // 0/1 — same MapLibre-filter caveat
}

const SELECTED_LAYER = "gctp-caches-selected";

export interface SelectedParking {
  point: [number, number];
  ownerCacheId: number;
}

export interface CachesLayerProps {
  params: SearchParams;
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
  selectedCacheIds,
  onSelectionChange,
  onParkingSelect,
}: CachesLayerProps): null {
  const { map, ready } = useMap();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["caches", params],
    queryFn: () =>
      listCaches({
        center: params.center,
        radiusM: params.radiusM,
        types: params.types.length > 0 ? params.types : undefined,
        excludeFound: params.excludeFound || undefined,
      }),
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    if (!ready) return;

    const caches = query.data?.caches ?? [];

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
        difficulty: c.difficulty,
        terrain: c.terrain,
        color: TYPE_COLORS[c.type] ?? TYPE_COLORS.Other,
        foundByMe: c.foundByMe ? 1 : 0,
        selected: selectedCacheIds?.has(c.id) ? 1 : 0,
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
          // Dim found caches so the unfound ones pop without being hidden.
          "circle-opacity": ["case", ["==", ["get", "foundByMe"], 1], 0.35, 1],
          "circle-stroke-opacity": [
            "case",
            ["==", ["get", "foundByMe"], 1],
            0.35,
            1,
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
          "circle-radius": 6,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#1565c0",
          "circle-stroke-width": 2,
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
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            9,
            8,
            14,
            14,
          ],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#ff1744",
          "circle-stroke-width": 3,
        },
      });
    }

    return undefined;
  }, [map, ready, query.data, selectedCacheIds]);

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

      const renderPopup = (foundByMe: boolean) => {
        root.render(
          <CachePopup
            code={props.code}
            name={props.name}
            type={props.type}
            difficulty={props.difficulty}
            terrain={props.terrain}
            foundByMe={foundByMe}
            onToggleFound={async () => {
              try {
                if (foundByMe) {
                  await unmarkCacheFound(props.id);
                } else {
                  await markCacheFound(props.id);
                }
                renderPopup(!foundByMe);
                void queryClient.invalidateQueries({ queryKey: ["caches"] });
              } catch (err) {
                console.error("toggle found failed", err);
              }
            }}
          />,
        );
      };

      renderPopup(props.foundByMe === 1);

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
