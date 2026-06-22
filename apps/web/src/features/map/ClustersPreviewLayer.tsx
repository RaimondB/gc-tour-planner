// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo } from "react";
import type maplibregl from "maplibre-gl";
import type { CacheSummaryDTO } from "@gctp/shared/caches";
import type { ClusterCandidate } from "@gctp/shared/tours";
import { collapseByProximity } from "./marker-collapse.js";
import { OVERLAP_PX } from "./pixel-cluster.js";
import { applyLayerOrder } from "./map-layers.js";
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
  chosenClusterId = null,
  deEmphasized = false,
  onCentroidClick,
  onCentroidHover,
}: {
  candidates: ClusterCandidate[] | null;
  caches: readonly CacheSummaryDTO[] | undefined;
  focusedClusterId: string | null;
  /** The picked cluster (the one shown in the picker). Its member rings are the
   *  prominent ones; every other cluster's rings are soft, so the selection
   *  stands out. Hovering a cluster also promotes it. */
  chosenClusterId?: string | null;
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

    // Z-order is the declarative registry's job (map-layers.ts): the centroids
    // sit above the caches but below the tour. When no tour is planned the tour
    // layers don't exist, so the centroids are effectively on top (tappable);
    // once a tour exists they fall beneath it. The tour-active de-emphasis is
    // OPACITY only (above), no longer a z-order flip — so no more centroid
    // floating over a routed loop.
    applyLayerOrder(map);
  }, [map, ready, candidates, focusedClusterId, deEmphasized]);

  // --- Preview lines (every cluster) + emphasis rings (focused only) ----
  useEffect(() => {
    if (!ready) return;

    // Preview "shape of the area" loops for EVERY cluster (zoom-independent).
    const lineFeatures: GeoJSON.Feature<
      GeoJSON.LineString,
      { clusterId: string; focused: number }
    >[] = [];
    for (const cluster of candidates ?? []) {
      const focused = cluster.clusterId === focusedClusterId ? 1 : 0;
      const memberCaches = cluster.cacheIds
        .map((id) => cacheById.get(id))
        .filter((c): c is CacheSummaryDTO => c != null);
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
    // Seed the emphasis source EMPTY before its layer attaches — computeEmphasis()
    // (which actually fills it) runs after the addLayer below, and MapLibre
    // rejects a layer whose source doesn't exist yet.
    if (!map.getSource(FOCUS_CACHES_SOURCE))
      upsertGeoJsonSource(map, FOCUS_CACHES_SOURCE, {
        type: "FeatureCollection",
        features: [],
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
          // A ring OUTSIDE the cache (transparent fill so the cache's own
          // colour/shape shows through), sitting SNUG around the marker (the
          // cache circle is ~9px at z14; the ring is ~11). The ACTIVE cluster
          // (picked, or hovered) gets a redder, thicker ring; every other
          // cluster's ring is a soft, thin orange — so the selection stands out
          // instead of every cluster screaming equally.
          //
          // The zoom interpolate MUST be top-level (a `["zoom"]` expression
          // can't be nested inside another expression like "+", or MapLibre
          // rejects the layer at addLayer) — so the per-feature `collapsed`
          // boost rides in the interpolate's OUTPUTS, not as an outer sum.
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            9,
            ["case", ["==", ["get", "collapsed"], 1], 8, 6],
            14,
            ["case", ["==", ["get", "collapsed"], 1], 13, 11],
          ],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": [
            "case",
            ["==", ["get", "active"], 1],
            "#d84315",
            "#f0a878",
          ],
          "circle-stroke-width": [
            "case",
            ["==", ["get", "active"], 1],
            2.8,
            1.6,
          ],
        },
      });
    }

    // Emphasis rings for EVERY cluster's members (the non-highlighted clusters
    // need to be visible too — without this they're just a lone centroid). AL
    // members collapse with the SAME pixel-proximity logic as the plain caches
    // layer, recomputed on zoom, so the ring sits on the collapsed pin rather
    // than on hidden stages. Focused rings are drawn last so they sit on top.
    const computeEmphasis = (): void => {
      const feats: GeoJSON.Feature<
        GeoJSON.Point,
        { active: number; collapsed: number }
      >[] = [];
      for (const cluster of candidates ?? []) {
        // The picked cluster (or the hovered one) is the "active" one — its
        // rings are prominent so the selection is obvious; the rest are soft.
        const active =
          cluster.clusterId === chosenClusterId ||
          cluster.clusterId === focusedClusterId
            ? 1
            : 0;
        const members = cluster.cacheIds
          .map((id) => cacheById.get(id))
          .filter((c): c is CacheSummaryDTO => c != null);
        const ring = (coord: [number, number], collapsed: number): void => {
          feats.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: coord },
            properties: { active, collapsed },
          });
        };
        // Regular caches never collapse (matches CachesLayer) — ring each.
        for (const c of members.filter((m) => m.type !== "Adventure Lab")) {
          ring(c.location.coordinates as [number, number], 0);
        }
        // AL stages collapse exactly like the plain layer.
        const { singles, groups } = collapseByProximity(
          members
            .filter((m) => m.type === "Adventure Lab")
            .map((c) => ({
              lng: c.location.coordinates[0]!,
              lat: c.location.coordinates[1]!,
              item: c,
            })),
          (lngLat) => map.project(lngLat),
          { thresholdPx: OVERLAP_PX },
        );
        for (const s of singles)
          ring(s.location.coordinates as [number, number], 0);
        for (const g of groups) ring(g.center, 1);
      }
      // Active rings last → drawn on top of the soft ones.
      feats.sort((a, b) => a.properties.active - b.properties.active);
      upsertGeoJsonSource(map, FOCUS_CACHES_SOURCE, {
        type: "FeatureCollection",
        features: feats,
      });
      map.triggerRepaint();
    };
    computeEmphasis();
    map.on("zoom", computeEmphasis);

    // Recede behind an active tour (ADR-0035 context hierarchy).
    map.setPaintProperty(
      PREVIEW_LINES_LAYER,
      "line-opacity",
      deEmphasized ? 0.2 : ["case", ["==", ["get", "focused"], 1], 0.95, 0.55],
    );
    map.setPaintProperty(
      FOCUS_CACHES_LAYER,
      "circle-stroke-opacity",
      deEmphasized ? 0.2 : 1,
    );
    applyLayerOrder(map);
    return () => {
      map.off("zoom", computeEmphasis);
    };
  }, [
    map,
    ready,
    candidates,
    focusedClusterId,
    chosenClusterId,
    cacheById,
    deEmphasized,
  ]);

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
