// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import maplibregl from "maplibre-gl";
import type { WalkingGraphResponse } from "@gctp/shared/tours";
import { fetchLeg, fetchWalkingGraph } from "../../lib/api.js";
import type { SearchParams } from "../../lib/search-params.js";
import { useMap } from "./MapContext.js";
import { bboxToCenterRadius, useViewportBbox } from "./useViewportBbox.js";

const SOURCE_ID = "gctp-walking-graph";
const EDGE_LAYER = "gctp-walking-graph-edges";
const SUSPICIOUS_LAYER = "gctp-walking-graph-suspicious";
const NODE_HALO_LAYER = "gctp-walking-graph-isolated";
// Transparent wide line on top of the edges so thin lines are easy to click.
const EDGE_HIT_LAYER = "gctp-walking-graph-hit";
// Dedicated source + layer for the selected edge's real OSRM path.
const ROUTE_SOURCE = "gctp-walking-graph-route";
const ROUTE_LAYER = "gctp-walking-graph-route-line";

/** The clicked edge, carrying the stats already on the edge + the click point. */
interface SelectedEdge {
  a: number;
  b: number;
  walkingM: number;
  walkingS: number;
  haversineM: number;
  suspicious: boolean;
  lng: number;
  lat: number;
}

export interface WalkingGraphLayerProps {
  /** When false, layer is unmounted (no fetch, no map source). */
  enabled: boolean;
  params: SearchParams;
  /** Same knobs the planner uses — match them so the visualisation reflects what the planner sees. */
  maxLinkMeters: number;
  distanceBudgetMeters: number;
  /** Walking speed (km/h) for the per-edge walk-time estimate in the popup. */
  avgWalkingKmh: number;
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
  avgWalkingKmh,
  onStatsChange,
}: WalkingGraphLayerProps): null {
  const { map, ready } = useMap();
  const [selectedEdge, setSelectedEdge] = useState<SelectedEdge | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
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
      // Remove layers + source when toggled off (route highlight + hit layer
      // first; they sit above the edges and share / sit beside the source).
      for (const id of [
        ROUTE_LAYER,
        EDGE_HIT_LAYER,
        SUSPICIOUS_LAYER,
        EDGE_LAYER,
        NODE_HALO_LAYER,
      ]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(ROUTE_SOURCE)) map.removeSource(ROUTE_SOURCE);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      popupRef.current?.remove();
      popupRef.current = null;
      setSelectedEdge(null);
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
          walkingS: e.walkingS,
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
    const existing = map.getSource(SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existing) existing.setData(collection);
    else map.addSource(SOURCE_ID, { type: "geojson", data: collection });

    if (!map.getLayer(EDGE_LAYER)) {
      map.addLayer({
        id: EDGE_LAYER,
        type: "line",
        source: SOURCE_ID,
        filter: [
          "all",
          ["==", ["geometry-type"], "LineString"],
          ["==", ["get", "suspicious"], 0],
        ],
        paint: {
          "line-color": "#1565c0",
          // Darker for longer edges so the long bridges stand out.
          "line-opacity": 0.55,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 2],
        },
      });
    }
    if (!map.getLayer(SUSPICIOUS_LAYER)) {
      map.addLayer({
        id: SUSPICIOUS_LAYER,
        type: "line",
        source: SOURCE_ID,
        filter: [
          "all",
          ["==", ["geometry-type"], "LineString"],
          ["==", ["get", "suspicious"], 1],
        ],
        paint: {
          "line-color": "#d50000",
          "line-opacity": 0.85,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 3],
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
    // Transparent wide line for forgiving edge clicks (queried on click).
    if (!map.getLayer(EDGE_HIT_LAYER)) {
      map.addLayer({
        id: EDGE_HIT_LAYER,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["geometry-type"], "LineString"],
        // Forgiving so the first click reliably lands on a thin line. Stale
        // popups (the earlier "stats next to the edge" complaint) are handled
        // by dismiss-on-click-away, not by shrinking the target.
        paint: { "line-color": "#000000", "line-opacity": 0, "line-width": 14 },
      });
    }
    // Selected edge's real OSRM path (highlight), in its own source so it's
    // independent of the edge collection.
    if (!map.getSource(ROUTE_SOURCE)) {
      map.addSource(ROUTE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getLayer(ROUTE_LAYER)) {
      map.addLayer({
        id: ROUTE_LAYER,
        type: "line",
        source: ROUTE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#00c853",
          "line-width": 4,
          "line-opacity": 0.95,
        },
      });
    }
  }, [map, ready, enabled, query.data, cr]);

  // Real OSRM path for the selected edge. Cache-first on the server, so the
  // first select of a pair hits OSRM once and repeats are instant.
  const legQuery = useQuery({
    queryKey: ["walking-edge-leg", selectedEdge?.a, selectedEdge?.b],
    enabled: selectedEdge !== null,
    gcTime: 30_000,
    queryFn: () => fetchLeg(selectedEdge!.a, selectedEdge!.b),
  });

  // Click an edge → select it. queryRenderedFeatures on the wide transparent
  // hit layer makes thin lines easy to hit; the global handler is robust to
  // the hit layer not existing yet.
  useEffect(() => {
    if (!ready || !enabled) return;
    const onClick = (e: maplibregl.MapMouseEvent): void => {
      if (!map.getLayer(EDGE_HIT_LAYER)) return;
      const f = map.queryRenderedFeatures(e.point, {
        layers: [EDGE_HIT_LAYER],
      })[0];
      if (!f) {
        // Clicked away from any edge → dismiss the popup + clear the path.
        setSelectedEdge(null);
        return;
      }
      const p = f.properties as Record<string, unknown>;
      setSelectedEdge({
        a: Number(p.a),
        b: Number(p.b),
        walkingM: Number(p.walkingM),
        walkingS: Number(p.walkingS),
        haversineM: Number(p.haversineM),
        suspicious: Number(p.suspicious) === 1,
        lng: e.lngLat.lng,
        lat: e.lngLat.lat,
      });
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [map, ready, enabled]);

  // Draw the selected edge's path + show its stats popup, reacting to the leg
  // fetch state.
  useEffect(() => {
    if (!ready) return;
    const routeSrc = map.getSource(ROUTE_SOURCE) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!selectedEdge) {
      routeSrc?.setData({ type: "FeatureCollection", features: [] });
      popupRef.current?.remove();
      popupRef.current = null;
      return;
    }
    const leg = legQuery.data;
    routeSrc?.setData(
      leg
        ? { type: "Feature", geometry: leg.geometry, properties: {} }
        : { type: "FeatureCollection", features: [] },
    );

    const codeOf = (id: number): string =>
      query.data?.nodes.find((n) => n.id === id)?.code ?? `#${id}`;
    const fmtT = (s: number): string =>
      s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`;
    const detour =
      selectedEdge.haversineM > 0
        ? `×${(selectedEdge.walkingM / selectedEdge.haversineM).toFixed(2)}`
        : "—";
    const walkEst =
      avgWalkingKmh > 0
        ? `${Math.round((selectedEdge.walkingM / 1000 / avgWalkingKmh) * 60)} min`
        : "—";
    const routeRow = legQuery.isFetching
      ? `<div style="color:#6b7280">routing…</div>`
      : leg
        ? `<div>OSRM route: ${Math.round(leg.meters)} m · ${fmtT(leg.seconds)}</div>`
        : `<div style="color:#b91c1c">no OSRM route for this pair</div>`;
    const html =
      `<div style="font:13px/1.45 system-ui,sans-serif">` +
      `<div style="font-weight:600;margin-bottom:3px">${codeOf(selectedEdge.a)} → ${codeOf(selectedEdge.b)}` +
      (selectedEdge.suspicious
        ? ` <span style="color:#b91c1c;font-weight:600">⚠ suspicious</span>`
        : "") +
      `</div>` +
      `<div>walking: ${Math.round(selectedEdge.walkingM)} m · ${fmtT(selectedEdge.walkingS)}</div>` +
      `<div>straight: ${Math.round(selectedEdge.haversineM)} m · detour ${detour}</div>` +
      `<div>walk @ ${avgWalkingKmh.toFixed(1)} km/h ≈ ${walkEst}</div>` +
      routeRow +
      `</div>`;

    if (!popupRef.current) {
      // Create + add ONCE. `addTo` on an already-open popup internally calls
      // remove() → fires "close" → would clear the selection, toggling the
      // route off on the very next effect run. So only addTo on creation;
      // updates below just move/refresh it.
      // maplibre 5: Evented.on() returns a Subscription, not the Popup — so we
      // can't chain it into the assignment any more. Build on a local, then store.
      const popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        maxWidth: "280px",
      });
      popup.on("close", () => {
        // User hit the X → clear selection so the highlighted path clears too.
        popupRef.current = null;
        setSelectedEdge(null);
      });
      popup
        .setLngLat([selectedEdge.lng, selectedEdge.lat])
        .setHTML(html)
        .addTo(map);
      popupRef.current = popup;
    } else {
      popupRef.current
        .setLngLat([selectedEdge.lng, selectedEdge.lat])
        .setHTML(html);
    }
  }, [
    map,
    ready,
    selectedEdge,
    legQuery.data,
    legQuery.isFetching,
    avgWalkingKmh,
    query.data,
  ]);

  // Teardown if the component unmounts while still enabled.
  useEffect(() => {
    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
    };
  }, []);

  return null;
}
