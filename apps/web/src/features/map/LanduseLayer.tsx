// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import { useQuery } from "@tanstack/react-query";
import type { LanduseKind } from "@gctp/shared/landuse";
import { listLanduse } from "../../lib/api.js";
import { radiusBbox, type SearchParams } from "../../lib/search-params.js";
import { useMap } from "./MapContext.js";

const SOURCE_ID = "gctp-landuse";
const FILL_LAYER = "gctp-landuse-fill";
const LINE_LAYER = "gctp-landuse-line";

/** Distinct, low-saturation per-kind palette so caches still pop on top. */
const KIND_COLORS: Record<LanduseKind, string> = {
  forest: "#2e7d32",
  park: "#66bb6a",
  residential: "#9e9e9e",
  farmland: "#d4ac0d",
  industrial: "#6d4c41",
  meadow: "#aed581",
  water: "#42a5f5",
  wetland: "#80deea",
  heath: "#bcaaa4",
  scrub: "#827717",
};

/**
 * Fetches and renders landuse polygons for the current search radius bbox.
 * Returns null when `params.showLanduse` is false — layers stay attached so
 * the next toggle-on doesn't re-fetch and re-paint from scratch, but the
 * paint is hidden via `visibility`.
 */
export function LanduseLayer({ params }: { params: SearchParams }): null {
  const { map, ready } = useMap();

  const bbox = radiusBbox(params.center, params.radiusM);
  const query = useQuery({
    queryKey: ["landuse", bbox],
    queryFn: () => listLanduse({ bbox }),
    enabled: params.showLanduse,
    placeholderData: (prev) => prev,
    staleTime: 60_000, // backend already caches for 30d; the client just dedupes within a session
  });

  // Push features onto the map source.
  useEffect(() => {
    if (!ready) return;
    const features = query.data?.features ?? [];
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: features.map((f) => ({
        type: "Feature",
        properties: {
          ...f.properties,
          color: KIND_COLORS[f.properties.kind] ?? "#999",
        },
        geometry: f.geometry,
      })),
    };

    const existing = map.getSource(SOURCE_ID);
    if (existing && "setData" in existing) {
      (existing as maplibregl.GeoJSONSource).setData(fc);
    } else {
      map.addSource(SOURCE_ID, { type: "geojson", data: fc });
    }

    if (!map.getLayer(FILL_LAYER)) {
      map.addLayer(
        {
          id: FILL_LAYER,
          type: "fill",
          source: SOURCE_ID,
          paint: {
            "fill-color": ["get", "color"],
            "fill-opacity": 0.25,
          },
        },
        firstLayerAbove(map),
      );
    }
    if (!map.getLayer(LINE_LAYER)) {
      map.addLayer(
        {
          id: LINE_LAYER,
          type: "line",
          source: SOURCE_ID,
          paint: {
            "line-color": ["get", "color"],
            "line-width": 0.5,
            "line-opacity": 0.6,
          },
        },
        firstLayerAbove(map),
      );
    }
  }, [map, ready, query.data]);

  // Toggle visibility instead of removing layers on showLanduse change.
  useEffect(() => {
    if (!ready) return;
    const v = params.showLanduse ? "visible" : "none";
    if (map.getLayer(FILL_LAYER))
      map.setLayoutProperty(FILL_LAYER, "visibility", v);
    if (map.getLayer(LINE_LAYER))
      map.setLayoutProperty(LINE_LAYER, "visibility", v);
  }, [map, ready, params.showLanduse]);

  return null;
}

/** Insert landuse below the radius circle so the radius outline stays visible. */
function firstLayerAbove(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle().layers ?? [];
  for (const id of ["gctp-radius-fill", "gctp-caches-circle"]) {
    if (layers.some((l) => l.id === id)) return id;
  }
  return undefined;
}
