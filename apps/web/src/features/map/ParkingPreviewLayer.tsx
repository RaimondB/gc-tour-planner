// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import { useQuery } from "@tanstack/react-query";
import { fetchParkingOptions } from "../../lib/api.js";
import { useMap } from "./MapContext.js";

const SOURCE_ID = "gctp-parking-preview";
const LINE_LAYER = "gctp-parking-preview-line";

/**
 * Fetches walking previews from each parking candidate near the cluster
 * to its nearest cache, and renders them as semi-transparent dashed
 * lines beneath the main tour polyline. Lets the user compare parking
 * options at a glance.
 *
 * Activates when a non-empty `cacheIds` is supplied (i.e. the user has
 * either selected a cluster from /tours/clusters or pinned a selection
 * via the Cluster Lab). Empty cacheIds → no fetch, no render.
 */
export function ParkingPreviewLayer({
  cacheIds,
}: {
  cacheIds: readonly number[];
}): null {
  const { map, ready } = useMap();

  const query = useQuery({
    queryKey: ["parking-options", [...cacheIds].sort((a, b) => a - b)],
    queryFn: () =>
      fetchParkingOptions({ cacheIds: [...cacheIds], maxOptions: 8 }),
    enabled: cacheIds.length > 0,
    staleTime: 5 * 60_000, // parking + osrm don't change mid-session
  });

  useEffect(() => {
    if (!ready) return;

    const options = query.data?.options ?? [];
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: options.map((opt) => ({
        type: "Feature",
        properties: {
          id: opt.id,
          walkingMeters: opt.walkingMeters,
          nearestCacheId: opt.nearestCacheId,
        },
        geometry: opt.polyline,
      })),
    };

    const existing = map.getSource(SOURCE_ID);
    if (existing && "setData" in existing) {
      (existing as maplibregl.GeoJSONSource).setData(fc);
    } else {
      map.addSource(SOURCE_ID, { type: "geojson", data: fc });
    }

    if (!map.getLayer(LINE_LAYER)) {
      // Render below the main tour polyline so the chosen tour stays
      // visually dominant. Dashed, semi-transparent — clearly "preview"
      // not "the route".
      map.addLayer(
        {
          id: LINE_LAYER,
          type: "line",
          source: SOURCE_ID,
          paint: {
            "line-color": "#1e88e5",
            "line-width": 2.5,
            "line-opacity": 0.55,
            "line-dasharray": [2, 1.5],
          },
        },
        firstTourLayer(map),
      );
    }
  }, [map, ready, query.data]);

  // Tear down when cacheIds clears so the previews disappear with the
  // cluster selection rather than lingering.
  useEffect(() => {
    if (!ready) return;
    if (cacheIds.length === 0) {
      if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }
  }, [map, ready, cacheIds.length]);

  return null;
}

/**
 * Place the preview lines just below the chosen-tour polyline (if any)
 * so the user sees the picked tour layered on top. Falls back to the
 * default top of the layer stack if the tour layer isn't mounted yet.
 */
function firstTourLayer(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle().layers ?? [];
  for (const id of ["gctp-tour-line", "gctp-clusters-preview-line"]) {
    if (layers.some((l) => l.id === id)) return id;
  }
  return undefined;
}
