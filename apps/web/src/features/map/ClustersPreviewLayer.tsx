// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo } from "react";
import type maplibregl from "maplibre-gl";
import type { CacheSummaryDTO } from "@gctp/shared/caches";
import type { ClusterCandidate } from "@gctp/shared/tours";
import { useMap } from "./MapContext.js";

const CENTROIDS_SOURCE = "gctp-cluster-centroids";
const CENTROIDS_LAYER = "gctp-cluster-centroids-circle";
const CENTROIDS_LABEL_LAYER = "gctp-cluster-centroids-label";
const FOCUS_CACHES_SOURCE = "gctp-cluster-focus-caches";
const FOCUS_CACHES_LAYER = "gctp-cluster-focus-caches-circle";
const PREVIEW_LINES_SOURCE = "gctp-cluster-preview-lines";
const PREVIEW_LINES_LAYER = "gctp-cluster-preview-lines";

/**
 * Spatial view of the planner's candidate clusters.
 *
 *   - Every cluster shows a numbered centroid chip and a straight-line
 *     preview polyline that walks its member caches in radial order around
 *     the centroid. The preview is intentionally a thin dashed line — it
 *     is a "shape of the area" hint, not a routed path.
 *   - The currently-focused cluster (hovered in the sidebar or clicked on
 *     the map) gets thicker, brighter strokes and emphasized cache markers.
 *   - Clicking a centroid on the map calls `onCentroidClick(clusterId)` so
 *     the sidebar can highlight + scroll the corresponding row.
 *
 * The OSRM-routed polyline (real plan) lives in `TourLayer.tsx` and renders
 * only after the user commits via "Plan this loop".
 */
export function ClustersPreviewLayer({
  candidates,
  caches,
  focusedClusterId,
  onCentroidClick,
  onCentroidDblClick,
}: {
  candidates: ClusterCandidate[] | null;
  caches: readonly CacheSummaryDTO[] | undefined;
  focusedClusterId: string | null;
  /** Single click — currently a no-op (App passes `() => {}`) so clicking
   *  around the map never changes focus or moves the camera. Kept as a hook. */
  onCentroidClick: (clusterId: string) => void;
  /** Double click — commit the cluster as the Tour context. */
  onCentroidDblClick: (clusterId: string) => void;
}): null {
  const { map, ready } = useMap();

  const cacheById = useMemo(() => {
    const out = new Map<number, CacheSummaryDTO>();
    for (const c of caches ?? []) out.set(c.id, c);
    return out;
  }, [caches]);

  // --- Centroids --------------------------------------------------------
  useEffect(() => {
    if (!ready) return;

    const features: GeoJSON.Feature<
      GeoJSON.Point,
      { rank: number; clusterId: string; focused: number }
    >[] = (candidates ?? []).map((c, i) => ({
      type: "Feature",
      geometry: c.centroid,
      properties: {
        rank: i + 1,
        clusterId: c.clusterId,
        focused: c.clusterId === focusedClusterId ? 1 : 0,
      },
    }));

    upsertGeoJsonSource(map, CENTROIDS_SOURCE, {
      type: "FeatureCollection",
      features,
    });

    if (!map.getLayer(CENTROIDS_LAYER)) {
      map.addLayer({
        id: CENTROIDS_LAYER,
        type: "circle",
        source: CENTROIDS_SOURCE,
        paint: {
          "circle-radius": ["case", ["==", ["get", "focused"], 1], 16, 12],
          "circle-color": [
            "case",
            ["==", ["get", "focused"], 1],
            "#d84315",
            "#fb923c",
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-opacity": 0.9,
        },
      });
    }
    if (!map.getLayer(CENTROIDS_LABEL_LAYER)) {
      map.addLayer({
        id: CENTROIDS_LABEL_LAYER,
        type: "symbol",
        source: CENTROIDS_SOURCE,
        layout: {
          "text-field": ["to-string", ["get", "rank"]],
          // Single font, not a stack — MapLibre 404s on comma-joined
          // stacks against demotiles. See TourLayer for the rationale.
          "text-font": ["Noto Sans Bold"],
          "text-size": 13,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#ffffff" },
      });
    }

    // Force the centroid + label to the top of the style every time the
    // candidates change. `addLayer` without a `beforeId` only puts them
    // on top *at the time of the call* — any layer mounted later in
    // App.tsx (TourLayer, ParkingPreviewLayer, walking-graph debug,
    // etc.) gets stacked above and steals the click target. Calling
    // `moveLayer(id)` with no second arg pops the layer to the very
    // top; label after circle so the number renders above the disc.
    if (map.getLayer(CENTROIDS_LAYER)) {
      map.moveLayer(CENTROIDS_LAYER);
    }
    if (map.getLayer(CENTROIDS_LABEL_LAYER)) {
      map.moveLayer(CENTROIDS_LABEL_LAYER);
    }
  }, [map, ready, candidates, focusedClusterId]);

  // --- Preview lines + emphasized cache markers, for every cluster ------
  useEffect(() => {
    if (!ready) return;

    const lineFeatures: GeoJSON.Feature<
      GeoJSON.LineString,
      { clusterId: string; focused: number }
    >[] = [];
    const cacheFeatures: GeoJSON.Feature<
      GeoJSON.Point,
      { clusterId: string; focused: number; code: string }
    >[] = [];

    for (const cluster of candidates ?? []) {
      const focused = cluster.clusterId === focusedClusterId ? 1 : 0;
      const memberCaches = cluster.cacheIds
        .map((id) => cacheById.get(id))
        .filter((c): c is CacheSummaryDTO => c != null);

      for (const c of memberCaches) {
        cacheFeatures.push({
          type: "Feature",
          geometry: c.location,
          properties: { clusterId: cluster.clusterId, focused, code: c.code },
        });
      }

      const sorted = sortCoordsByAngle(
        memberCaches.map((c) => c.location.coordinates),
        cluster.centroid.coordinates,
      );
      if (sorted.length >= 2) {
        const closed: [number, number][] = [...sorted, sorted[0]!];
        lineFeatures.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: closed },
          properties: { clusterId: cluster.clusterId, focused },
        });
      }
    }

    upsertGeoJsonSource(map, PREVIEW_LINES_SOURCE, {
      type: "FeatureCollection",
      features: lineFeatures,
    });
    upsertGeoJsonSource(map, FOCUS_CACHES_SOURCE, {
      type: "FeatureCollection",
      features: cacheFeatures,
    });

    if (!map.getLayer(PREVIEW_LINES_LAYER)) {
      map.addLayer({
        id: PREVIEW_LINES_LAYER,
        type: "line",
        source: PREVIEW_LINES_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "case",
            ["==", ["get", "focused"], 1],
            "#d84315",
            "#fdba74",
          ],
          "line-width": ["case", ["==", ["get", "focused"], 1], 2.5, 1.5],
          "line-dasharray": [2, 2],
          "line-opacity": ["case", ["==", ["get", "focused"], 1], 0.95, 0.55],
        },
      });
    }
    if (!map.getLayer(FOCUS_CACHES_LAYER)) {
      map.addLayer({
        id: FOCUS_CACHES_LAYER,
        type: "circle",
        source: FOCUS_CACHES_SOURCE,
        paint: {
          "circle-radius": ["case", ["==", ["get", "focused"], 1], 9, 6],
          "circle-color": "#fff7ed",
          "circle-stroke-color": [
            "case",
            ["==", ["get", "focused"], 1],
            "#d84315",
            "#fdba74",
          ],
          "circle-stroke-width": [
            "case",
            ["==", ["get", "focused"], 1],
            2.5,
            1.5,
          ],
          "circle-opacity": ["case", ["==", ["get", "focused"], 1], 1, 0.65],
        },
      });
    }
  }, [map, ready, candidates, focusedClusterId, cacheById]);

  // --- Centroid click → notify parent (sidebar highlights + scrolls) ----
  useEffect(() => {
    if (!ready) return;
    const handler = (
      e: maplibregl.MapMouseEvent & {
        features?: maplibregl.MapGeoJSONFeature[];
      },
    ) => {
      const f = e.features?.[0];
      if (!f) return;
      const id = (f.properties as { clusterId?: string }).clusterId;
      if (id) onCentroidClick(id);
    };
    const dblHandler = (
      e: maplibregl.MapMouseEvent & {
        features?: maplibregl.MapGeoJSONFeature[];
      },
    ) => {
      const f = e.features?.[0];
      if (!f) return;
      // Stop the map's default double-click zoom — here a dbl-click selects.
      e.preventDefault();
      const id = (f.properties as { clusterId?: string }).clusterId;
      if (id) onCentroidDblClick(id);
    };
    const enter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
    };
    map.on("click", CENTROIDS_LAYER, handler);
    map.on("dblclick", CENTROIDS_LAYER, dblHandler);
    map.on("mouseenter", CENTROIDS_LAYER, enter);
    map.on("mouseleave", CENTROIDS_LAYER, leave);
    return () => {
      map.off("click", CENTROIDS_LAYER, handler);
      map.off("dblclick", CENTROIDS_LAYER, dblHandler);
      map.off("mouseenter", CENTROIDS_LAYER, enter);
      map.off("mouseleave", CENTROIDS_LAYER, leave);
    };
  }, [map, ready, onCentroidClick, onCentroidDblClick]);

  return null;
}

function sortCoordsByAngle(
  coords: readonly [number, number][],
  centroid: readonly [number, number] | undefined,
): [number, number][] {
  if (coords.length === 0) return [];
  const c =
    centroid ??
    ([
      coords.reduce((s, p) => s + p[0], 0) / coords.length,
      coords.reduce((s, p) => s + p[1], 0) / coords.length,
    ] as [number, number]);
  return coords
    .map((p) => ({ p, a: Math.atan2(p[1] - c[1], p[0] - c[0]) }))
    .sort((a, b) => a.a - b.a)
    .map((x) => x.p);
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
