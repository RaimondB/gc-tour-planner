// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type maplibregl from "maplibre-gl";
import { listTourFootprints } from "../../lib/api.js";
import { useOnline } from "../shell/ConnectivityProvider.js";
import { useTourSession } from "../tours/TourSessionProvider.js";
import { applyLayerOrder } from "./map-layers.js";
import { useMap } from "./MapContext.js";

const SOURCE = "gctp-saved-tours";
const LINE_LAYER = "gctp-saved-tours-line";
const HIT_LAYER = "gctp-saved-tours-hit";

/**
 * Faint dashed footprints of the user's saved tours, drawn as background
 * context on the planner map (Feature 1). Each footprint is a simplified
 * LineString from `GET /tours/footprints`; clicking one opens that tour via the
 * tour session.
 *
 * Online-only enrichment: when offline we render nothing (the *open* tour has
 * its own durable IndexedDB path in {@link TourSessionProvider}; these
 * background loops are disposable). The currently-open tour is excluded so its
 * bright route in {@link TourLayer} doesn't ghost a dim line underneath.
 *
 * Z-order: declared low in {@link MAP_LAYER_ORDER} (below cluster previews and
 * caches), so it reads as a background hint. Clicks on the footprint line where
 * nothing else sits still register on the wide invisible hit layer.
 */
export function SavedToursLayer({ enabled }: { enabled: boolean }): null {
  const { map, ready } = useMap();
  const online = useOnline();
  const { openTourId, openTour } = useTourSession();

  const footprintsQuery = useQuery({
    queryKey: ["tour-footprints"],
    queryFn: () => listTourFootprints(),
    enabled: enabled && online,
  });
  const footprints = footprintsQuery.data;

  // --- Source + layers ---------------------------------------------------
  useEffect(() => {
    if (!ready) return;

    // Disabled / offline / no data → tear the layers down so they don't linger.
    if (!enabled || !footprints || footprints.length === 0) {
      removeLayers(map);
      return;
    }

    const features: GeoJSON.Feature<
      GeoJSON.LineString,
      { id: string; name: string }
    >[] = footprints
      // Don't double-draw the open tour — TourLayer owns its bright route.
      .filter((f) => f.id !== openTourId)
      .map((f) => ({
        type: "Feature",
        geometry: f.geometry,
        properties: { id: f.id, name: f.name },
      }));

    upsertGeoJsonSource(map, SOURCE, {
      type: "FeatureCollection",
      features,
    });

    if (!map.getLayer(LINE_LAYER)) {
      map.addLayer({
        id: LINE_LAYER,
        type: "line",
        source: SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#64748b",
          "line-width": 1.5,
          "line-opacity": 0.45,
          "line-dasharray": [3, 2],
        },
      });
    }
    if (!map.getLayer(HIT_LAYER)) {
      // Wide invisible stroke so the thin dashed line is actually clickable.
      map.addLayer({
        id: HIT_LAYER,
        type: "line",
        source: SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#000000", "line-opacity": 0, "line-width": 12 },
      });
    }
    applyLayerOrder(map);
  }, [map, ready, enabled, footprints, openTourId]);

  // --- Click → open the tour; pointer cursor on hover --------------------
  useEffect(() => {
    if (!ready) return;
    const handler = (
      e: maplibregl.MapMouseEvent & {
        features?: maplibregl.MapGeoJSONFeature[];
      },
    ) => {
      const id = (e.features?.[0]?.properties as { id?: string })?.id;
      if (id) openTour(id);
    };
    const enter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
    };
    map.on("click", HIT_LAYER, handler);
    map.on("mouseenter", HIT_LAYER, enter);
    map.on("mouseleave", HIT_LAYER, leave);
    return () => {
      map.off("click", HIT_LAYER, handler);
      map.off("mouseenter", HIT_LAYER, enter);
      map.off("mouseleave", HIT_LAYER, leave);
    };
  }, [map, ready, openTour]);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      if (ready) removeLayers(map);
    };
  }, [map, ready]);

  return null;
}

function removeLayers(map: maplibregl.Map): void {
  for (const id of [HIT_LAYER, LINE_LAYER]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
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
