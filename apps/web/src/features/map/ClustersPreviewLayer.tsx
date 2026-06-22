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
 *   - The currently-focused cluster (hovered in the sidebar/map) gets thicker,
 *     brighter strokes and emphasized cache markers — but hovering NEVER moves
 *     the camera.
 *   - A single tap on a centroid calls `onCentroidClick(clusterId)` — the one
 *     explicit "frame this cluster + make it the Tour context" gesture
 *     (touch-friendly; replaces the old dbl-click-to-select).
 *
 * The OSRM-routed polyline (real plan) lives in `TourLayer.tsx` and renders
 * only after the user commits via "Plan this loop".
 */
export function ClustersPreviewLayer({
  candidates,
  caches,
  focusedClusterId,
  deEmphasized = false,
  onCentroidClick,
  onCentroidHover,
}: {
  candidates: ClusterCandidate[] | null;
  caches: readonly CacheSummaryDTO[] | undefined;
  focusedClusterId: string | null;
  /**
   * When a tour is active, the cluster preview is NOT the primary context
   * (ADR-0035 context hierarchy: tour > cluster > plain). De-emphasised, it
   * recedes (lower opacity) and stops forcing its centroids above the tour —
   * which is what kept a cluster centroid floating over a routed loop.
   */
  deEmphasized?: boolean;
  /** Single tap — frame the cluster + select it as the Tour context. */
  onCentroidClick: (clusterId: string) => void;
  /** Hover (desktop) — emphasize the cluster without moving the camera. */
  onCentroidHover: (clusterId: string | null) => void;
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
    // Context hierarchy (ADR-0035): when a tour owns the view, recede.
    map.setPaintProperty(
      CENTROIDS_LAYER,
      "circle-opacity",
      deEmphasized ? 0.3 : 0.9,
    );
    map.setPaintProperty(
      CENTROIDS_LAYER,
      "circle-stroke-opacity",
      deEmphasized ? 0.3 : 1,
    );
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

    map.setPaintProperty(
      CENTROIDS_LABEL_LAYER,
      "text-opacity",
      deEmphasized ? 0.3 : 1,
    );

    // Force the centroid + label to the top of the style every time the
    // candidates change. `addLayer` without a `beforeId` only puts them
    // on top *at the time of the call* — any layer mounted later in
    // App.tsx (TourLayer, ParkingPreviewLayer, walking-graph debug,
    // etc.) gets stacked above and steals the click target. Calling
    // `moveLayer(id)` with no second arg pops the layer to the very
    // top; label after circle so the number renders above the disc.
    // BUT when a tour is active (deEmphasized) we DON'T pop above it — the
    // tour is the primary context, so the centroids stay beneath it (no more
    // cluster centroid floating over a routed loop).
    if (!deEmphasized) {
      if (map.getLayer(CENTROIDS_LAYER)) {
        map.moveLayer(CENTROIDS_LAYER);
      }
      if (map.getLayer(CENTROIDS_LABEL_LAYER)) {
        map.moveLayer(CENTROIDS_LABEL_LAYER);
      }
    }
  }, [map, ready, candidates, focusedClusterId, deEmphasized]);

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
    // Recede behind an active tour (ADR-0035 context hierarchy).
    map.setPaintProperty(
      PREVIEW_LINES_LAYER,
      "line-opacity",
      deEmphasized ? 0.2 : ["case", ["==", ["get", "focused"], 1], 0.95, 0.55],
    );
    map.setPaintProperty(
      FOCUS_CACHES_LAYER,
      "circle-opacity",
      deEmphasized ? 0.2 : ["case", ["==", ["get", "focused"], 1], 1, 0.65],
    );
  }, [map, ready, candidates, focusedClusterId, cacheById, deEmphasized]);

  // --- Centroid tap → frame + select; hover → emphasize (no camera) ----
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
    const enter = (
      e: maplibregl.MapMouseEvent & {
        features?: maplibregl.MapGeoJSONFeature[];
      },
    ) => {
      map.getCanvas().style.cursor = "pointer";
      const id = (e.features?.[0]?.properties as { clusterId?: string })
        ?.clusterId;
      if (id) onCentroidHover(id);
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
      onCentroidHover(null);
    };
    map.on("click", CENTROIDS_LAYER, handler);
    map.on("mouseenter", CENTROIDS_LAYER, enter);
    map.on("mouseleave", CENTROIDS_LAYER, leave);
    return () => {
      map.off("click", CENTROIDS_LAYER, handler);
      map.off("mouseenter", CENTROIDS_LAYER, enter);
      map.off("mouseleave", CENTROIDS_LAYER, leave);
    };
  }, [map, ready, onCentroidClick, onCentroidHover]);

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
