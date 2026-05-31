// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type maplibregl from "maplibre-gl";
import type { WalkingGraphResponse } from "@gctp/shared/tours";
import { fetchWalkingGraph } from "../../lib/api.js";
import type { SearchParams } from "../../lib/search-params.js";
import { useMap } from "./MapContext.js";
import { bboxToCenterRadius, useViewportBbox } from "./useViewportBbox.js";

const SOURCE_ID = "gctp-walking-graph";
const EDGE_LAYER = "gctp-walking-graph-edges";
const SUSPICIOUS_LAYER = "gctp-walking-graph-suspicious";
const NODE_HALO_LAYER = "gctp-walking-graph-isolated";

export interface WalkingGraphLayerProps {
  /** When false, layer is unmounted (no fetch, no map source). */
  enabled: boolean;
  params: SearchParams;
  /** Same knobs the planner uses — match them so the visualisation reflects what the planner sees. */
  maxLinkMeters: number;
  distanceBudgetMeters: number;
  /** Called once the fetch resolves so the sidebar can show counts. */
  onStatsChange?: (stats: WalkingGraphResponse["stats"] | null) => void;
}

/**
 * Renders the sparse OSRM walking graph for the current search area as a
 * MapLibre line layer, with suspicious zero-distance cells highlighted in
 * red so stale `route_legs` rows are obvious at a glance.
 *
 * Toggled from the Planner sidebar — most users won't care, but for debugging
 * "why didn't these caches cluster?" it's the fastest answer: if there's no
 * line between them, there's no walking edge.
 */
export function WalkingGraphLayer({
  enabled,
  params,
  maxLinkMeters,
  distanceBudgetMeters,
  onStatsChange,
}: WalkingGraphLayerProps): null {
  const { map, ready } = useMap();
  // Follow the viewport rather than the search radius — the walking
  // graph is heavy (full OSRM /table over the bbox's caches) so we
  // gate it to z12+ and snap to a moderately coarse grid so panning a
  // little doesn't re-fetch a thousand edges.
  const vpBbox = useViewportBbox({
    minZoom: 12,
    gridDeg: 0.03,
    debounceMs: 400,
  });
  const cr = vpBbox ? bboxToCenterRadius(vpBbox) : null;
  const query = useQuery({
    queryKey: [
      "walking-graph",
      cr?.center,
      cr?.radiusM,
      params.types,
      maxLinkMeters,
      distanceBudgetMeters,
    ],
    enabled: enabled && ready && cr !== null,
    // Heaviest payload in the app (thousands of edge/node features) and a
    // debug-only overlay — don't let abandoned bbox entries linger. Shorter
    // than the global 60s default.
    gcTime: 30_000,
    queryFn: () =>
      fetchWalkingGraph({
        center: cr!.center,
        radiusM: cr!.radiusM,
        hardFilters: {
          types: params.types.length > 0 ? params.types : undefined,
        },
        maxLinkMeters,
        distanceBudgetMeters,
      }),
  });

  useEffect(() => {
    if (query.data) onStatsChange?.(query.data.stats);
    if (!enabled) onStatsChange?.(null);
  }, [query.data, enabled, onStatsChange]);

  useEffect(() => {
    if (!ready) return;
    if (!enabled) {
      // Remove layers + source when toggled off.
      for (const id of [SUSPICIOUS_LAYER, EDGE_LAYER, NODE_HALO_LAYER]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      return;
    }
    // Below the layer's minZoom the viewport bbox is null and we skip
    // the fetch — but without clearing the source the previous edges
    // keep rendering, looking like the graph survived the zoom-out.
    // Push an empty FC so the canvas matches the (no-)fetch state.
    if (cr === null) {
      const existing = map.getSource(SOURCE_ID);
      if (existing && "setData" in existing) {
        (existing as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: [],
        });
      }
      return;
    }
    const data = query.data;
    if (!data) return;

    const nodeById = new Map(data.nodes.map((n) => [n.id, n]));
    const edgeFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = [];
    for (const e of data.edges) {
      const a = nodeById.get(e.a);
      const b = nodeById.get(e.b);
      if (!a || !b) continue;
      edgeFeatures.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [a.lng, a.lat],
            [b.lng, b.lat],
          ],
        },
        properties: {
          a: e.a,
          b: e.b,
          walkingM: e.walkingM,
          haversineM: e.haversineM,
          suspicious: e.suspicious ? 1 : 0,
        },
      });
    }
    const isolatedFeatures: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const n of data.nodes) {
      if (n.degree > 0) continue;
      isolatedFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [n.lng, n.lat] },
        properties: { id: n.id, code: n.code },
      });
    }

    const collection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [...edgeFeatures, ...isolatedFeatures],
    };
    const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (existing) existing.setData(collection);
    else map.addSource(SOURCE_ID, { type: "geojson", data: collection });

    if (!map.getLayer(EDGE_LAYER)) {
      map.addLayer({
        id: EDGE_LAYER,
        type: "line",
        source: SOURCE_ID,
        filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "suspicious"], 0]],
        paint: {
          "line-color": "#1565c0",
          // Darker for longer edges so the long bridges stand out.
          "line-opacity": 0.55,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            1,
            14,
            2,
          ],
        },
      });
    }
    if (!map.getLayer(SUSPICIOUS_LAYER)) {
      map.addLayer({
        id: SUSPICIOUS_LAYER,
        type: "line",
        source: SOURCE_ID,
        filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "suspicious"], 1]],
        paint: {
          "line-color": "#d50000",
          "line-opacity": 0.85,
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            2,
            14,
            3,
          ],
          "line-dasharray": [2, 2],
        },
      });
    }
    if (!map.getLayer(NODE_HALO_LAYER)) {
      map.addLayer({
        id: NODE_HALO_LAYER,
        type: "circle",
        source: SOURCE_ID,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 12,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#ff6f00",
          "circle-stroke-width": 2,
          "circle-stroke-opacity": 0.9,
        },
      });
    }
  }, [map, ready, enabled, query.data, cr]);

  return null;
}
