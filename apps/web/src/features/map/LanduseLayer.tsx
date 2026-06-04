// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import { useQuery } from "@tanstack/react-query";
import type { LanduseKind } from "@gctp/shared/landuse";
import { listLanduse } from "../../lib/api.js";
import { type SearchParams } from "../../lib/search-params.js";
import { useMap } from "./MapContext.js";
import { useViewportBbox } from "./useViewportBbox.js";

const SOURCE_ID = "gctp-landuse";
const FILL_LAYER = "gctp-landuse-fill";
const LINE_LAYER = "gctp-landuse-line";

/**
 * Saturated, distinct per-kind palette. Each fill renders at 35% opacity, so
 * the basemap stays legible while every kind is unambiguous against the
 * default OSM raster. Residential is intentionally pink/red (clearly NOT
 * basemap gray) and water is vivid blue (separable from the search circle).
 */
const KIND_COLORS: Record<LanduseKind, string> = {
  forest: "#2e7d32",
  park: "#7cb342",
  residential: "#ef5350",
  farmland: "#fbc02d",
  industrial: "#8e24aa",
  meadow: "#c0ca33",
  water: "#1e88e5",
  wetland: "#26c6da",
  heath: "#a1887f",
  scrub: "#9e9d24",
};

/**
 * Fetches and renders landuse polygons for whatever's currently in the
 * map viewport. Refetches on `moveend` (debounced + grid-snapped so
 * small pans inside a tile don't trigger refetches). Because the
 * server-side LOD (`ST_SimplifyPreserveTopology` tolerance + envelope
 * area floor) scales with the bbox width, zooming in produces a
 * smaller bbox → smaller tolerance → finer detail automatically.
 *
 * Returns null when `params.showLanduse` is false — layers stay attached
 * so the next toggle-on doesn't re-fetch and re-paint from scratch, but
 * the paint is hidden via `visibility`.
 */
export function LanduseLayer({ params }: { params: SearchParams }): null {
  const { map, ready } = useMap();

  // minZoom 8: at z7 widthDeg ≈ 2.8° which overshoots the server's
  // MAX_DELTA_DEG=2.5° cap; z8 (~1.4° wide) fits comfortably and covers
  // typical region-wide views over NL. The grid is 0.05° — ~5.5 km at
  // lat 52°. Landuse polygons are large enough that a coarser grid
  // than parking still gives smooth panning.
  const bbox = useViewportBbox({
    minZoom: 8,
    gridDeg: 0.05,
    debounceMs: 300,
  });
  const query = useQuery({
    queryKey: ["landuse", bbox],
    queryFn: () => listLanduse({ bbox: bbox! }),
    enabled: params.showLanduse && bbox !== null,
    placeholderData: (prev) => prev,
    staleTime: 60_000, // backend already caches for 30d; the client just dedupes within a session
  });

  // Push features onto the map source. When the viewport drops below
  // `minZoom`, `bbox` becomes null and the query is gated off — without
  // clearing the source the previously-fetched polygons would keep
  // rendering, making the layer look like it survived the zoom-out.
  useEffect(() => {
    if (!ready) return;
    const features = bbox === null ? [] : (query.data?.features ?? []);
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
            "fill-opacity": 0.4,
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
            "line-width": 0.75,
            "line-opacity": 0.8,
          },
        },
        firstLayerAbove(map),
      );
    }
  }, [map, ready, query.data, bbox]);

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

/**
 * Insert landuse below the radius outline and the cache markers so they all
 * stay visible on top. Returns undefined if no such layer exists yet — then
 * MapLibre appends to the top, which is fine for the first paint.
 */
function firstLayerAbove(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle().layers ?? [];
  for (const id of ["gctp-radius-line", "gctp-caches-circle"]) {
    if (layers.some((l) => l.id === id)) return id;
  }
  return undefined;
}
