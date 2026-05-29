// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from "react";
import type maplibregl from "maplibre-gl";
import type { GeoJsonLineString } from "@gctp/shared/geo";
import type { ViaRouteResponse } from "@gctp/shared/tours";
import { fetchViaRoute } from "../../lib/api.js";
import { useMap } from "./MapContext.js";

const SOURCE_LINE = "gctp-leg-via-live-line";
const LAYER_LINE = "gctp-leg-via-live-line-stroke";
const SOURCE_MARKER = "gctp-leg-via-marker";
const LAYER_MARKER = "gctp-leg-via-marker-circle";
const LAYER_MARKER_RING = "gctp-leg-via-marker-ring";

/** State carried in props so the parent can drive lifecycle + commit on dragend. */
export interface ViaDragState {
  legIndex: number;
  fromCacheId: number;
  toCacheId: number;
  /** Where the marker is right now — drives both the dot and the OSRM probe. */
  position: [number, number];
  /** Last successful OSRM `from→via→to` reply; rendered as the live line. */
  live: { meters: number; seconds: number; geometry: GeoJsonLineString } | null;
  /** `"nopath"` tints the marker red so a drag into water/private land is visible. */
  status: "loading" | "ok" | "nopath";
}

/**
 * Draggable via-waypoint for the currently-selected leg (FR-T11 follow-up).
 *
 * Driven entirely by props from the parent (App.tsx): when `state !== null`,
 * the marker + live polyline are rendered. The layer itself owns:
 *   * MapLibre `mousedown`/`mousemove`/`mouseup` plumbing (disabling dragPan
 *     while a drag is active so the map doesn't pan under the cursor).
 *   * Trailing-edge throttling at ~60 ms with single-in-flight + AbortController
 *     so OSRM never receives a backlog; the latest position always wins.
 *   * Calling back into the parent on every successful response (live preview)
 *     and on dragend (commit into `legPicks`).
 *
 * The parent decides initial position (typically the midpoint of the leg's
 * current geometry) and commits the final `{ meters, seconds, geometry }`
 * into `legPicks[legIndex] = { kind: "via", … }` on `onCommit`.
 */
export function LegViaPointLayer({
  state,
  onPositionChange,
  onLiveChange,
  onStatusChange,
  onCommit,
}: {
  state: ViaDragState | null;
  /** Called from `mousemove` with every new position (cheap UI updates). */
  onPositionChange: (pos: [number, number]) => void;
  /** Called when OSRM returns a successful via-route (paint the preview). */
  onLiveChange: (
    live: { meters: number; seconds: number; geometry: GeoJsonLineString } | null,
  ) => void;
  /** Loading / NoRoute feedback for the marker tint. */
  onStatusChange: (status: "loading" | "ok" | "nopath") => void;
  /**
   * Called once on dragend with the final route + final via position
   * (commits into `legPicks` as a `{ kind: "via" }` entry).
   */
  onCommit: (
    final: { meters: number; seconds: number; geometry: GeoJsonLineString },
    position: [number, number],
  ) => void;
}): null {
  const { map, ready } = useMap();

  // Refs so the throttle/inflight/drag closures stay stable across renders.
  // We don't want re-renders to swap the inflight controller mid-drag.
  const inflightRef = useRef<AbortController | null>(null);
  const pendingPosRef = useRef<[number, number] | null>(null);
  const scheduledRef = useRef(false);
  const isDraggingRef = useRef(false);
  const latestRouteRef = useRef<{
    meters: number;
    seconds: number;
    geometry: GeoJsonLineString;
  } | null>(null);

  // Stable refs for the callbacks so the event listeners attached below
  // don't need to be torn down on every parent re-render.
  const onPositionChangeRef = useRef(onPositionChange);
  const onLiveChangeRef = useRef(onLiveChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onCommitRef = useRef(onCommit);
  onPositionChangeRef.current = onPositionChange;
  onLiveChangeRef.current = onLiveChange;
  onStatusChangeRef.current = onStatusChange;
  onCommitRef.current = onCommit;

  // Track which leg's drag context the in-flight callbacks belong to, so
  // a switch to a different leg doesn't paint a stale response.
  const stateRef = useRef<ViaDragState | null>(null);
  stateRef.current = state;

  // Render the marker + live polyline whenever props change. Source/layer
  // creation is idempotent; styles flip via paint properties.
  useEffect(() => {
    if (!ready) return;

    const lineFc: GeoJSON.FeatureCollection = state?.live
      ? {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: state.live.geometry,
              properties: {},
            },
          ],
        }
      : { type: "FeatureCollection", features: [] };

    const markerFc: GeoJSON.FeatureCollection = state
      ? {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: state.position },
              properties: { status: state.status },
            },
          ],
        }
      : { type: "FeatureCollection", features: [] };

    upsert(map, SOURCE_LINE, lineFc);
    upsert(map, SOURCE_MARKER, markerFc);

    if (!map.getLayer(LAYER_LINE)) {
      map.addLayer({
        id: LAYER_LINE,
        type: "line",
        source: SOURCE_LINE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#7c4dff",
          "line-width": 5,
          "line-opacity": 0.9,
        },
      });
    }
    if (!map.getLayer(LAYER_MARKER_RING)) {
      map.addLayer({
        id: LAYER_MARKER_RING,
        type: "circle",
        source: SOURCE_MARKER,
        paint: {
          "circle-radius": 14,
          "circle-color": "#ffffff",
          "circle-opacity": 0.5,
          "circle-stroke-color": [
            "match",
            ["get", "status"],
            "nopath",
            "#d50000",
            "loading",
            "#ff9800",
            "#7c4dff",
          ],
          "circle-stroke-width": 2,
        },
      });
    }
    if (!map.getLayer(LAYER_MARKER)) {
      map.addLayer({
        id: LAYER_MARKER,
        type: "circle",
        source: SOURCE_MARKER,
        paint: {
          "circle-radius": 7,
          "circle-color": [
            "match",
            ["get", "status"],
            "nopath",
            "#d50000",
            "#7c4dff",
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
    }
    // Keep marker + line above the tour polyline so they're always
    // visible. Idempotent — moveLayer is a no-op when the layer is
    // already on top.
    if (map.getLayer(LAYER_LINE)) map.moveLayer(LAYER_LINE);
    if (map.getLayer(LAYER_MARKER_RING)) map.moveLayer(LAYER_MARKER_RING);
    if (map.getLayer(LAYER_MARKER)) map.moveLayer(LAYER_MARKER);
  }, [map, ready, state]);

  // When `state` flips to null (user closed/reset), abort any in-flight
  // request and wipe internal drag state so a stale response can't fire.
  useEffect(() => {
    if (state) return;
    if (inflightRef.current) {
      inflightRef.current.abort();
      inflightRef.current = null;
    }
    pendingPosRef.current = null;
    scheduledRef.current = false;
    isDraggingRef.current = false;
    latestRouteRef.current = null;
  }, [state]);

  // Initial fetch: when the marker is first dropped (state present, no
  // preview yet, not dragging), kick off one OSRM probe so the user
  // sees the via-routed leg before they touch the marker. Subsequent
  // refinements come through the drag handlers above.
  const initialFetchKey =
    state && !state.live && !isDraggingRef.current
      ? `${state.legIndex}:${state.position[0]},${state.position[1]}`
      : null;
  useEffect(() => {
    if (!initialFetchKey) return;
    const ctx = stateRef.current;
    if (!ctx) return;
    const controller = new AbortController();
    if (inflightRef.current) inflightRef.current.abort();
    inflightRef.current = controller;
    onStatusChangeRef.current("loading");
    void (async () => {
      try {
        const response = await fetchViaRoute(
          {
            fromCacheId: ctx.fromCacheId,
            toCacheId: ctx.toCacheId,
            via: ctx.position,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (response.route) {
          latestRouteRef.current = response.route;
          onLiveChangeRef.current(response.route);
          onStatusChangeRef.current("ok");
        } else {
          onStatusChangeRef.current("nopath");
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn(
          "[via-route] initial fetch failed:",
          (err as Error).message,
        );
      }
    })();
    return () => controller.abort();
  }, [initialFetchKey]);

  // Wire the drag interaction. Single-in-flight + trailing-edge throttle
  // at ~60 ms guarantees OSRM never sees a backlog; the most recent
  // position always wins. AbortController on the in-flight request lets
  // a fast user-drag cancel an OSRM call that's already 50% through —
  // important when the OSRM container is briefly slow.
  useEffect(() => {
    if (!ready) return;
    if (!state) return;

    const THROTTLE_MS = 60;

    const fireForLatest = async (): Promise<void> => {
      const pos = pendingPosRef.current;
      pendingPosRef.current = null;
      scheduledRef.current = false;
      if (!pos) return;
      const ctx = stateRef.current;
      if (!ctx) return;
      const controller = new AbortController();
      // Replace any in-flight request — its response is moot now.
      if (inflightRef.current) inflightRef.current.abort();
      inflightRef.current = controller;
      onStatusChangeRef.current("loading");
      let response: ViaRouteResponse | null = null;
      try {
        response = await fetchViaRoute(
          {
            fromCacheId: ctx.fromCacheId,
            toCacheId: ctx.toCacheId,
            via: pos,
          },
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        // Network errors during drag: don't blow up the UI; treat as
        // transient and keep showing the last successful preview.
        console.warn("[via-route] fetch failed:", (err as Error).message);
      }
      if (controller.signal.aborted) return;
      if (inflightRef.current === controller) inflightRef.current = null;
      if (response?.route) {
        latestRouteRef.current = response.route;
        onLiveChangeRef.current(response.route);
        onStatusChangeRef.current("ok");
      } else {
        // OSRM said NoRoute for from→via→to. Keep the last successful
        // preview on screen so the user has a frame of reference, and
        // tint the marker red.
        onStatusChangeRef.current("nopath");
      }
      // If a newer position came in while we were waiting, fire again
      // immediately — the trailing-edge throttle has already buffered.
      if (pendingPosRef.current) {
        scheduleFire();
      }
    };

    const scheduleFire = (): void => {
      if (scheduledRef.current) return;
      scheduledRef.current = true;
      setTimeout(() => void fireForLatest(), THROTTLE_MS);
    };

    const onMarkerMouseDown = (e: maplibregl.MapMouseEvent): void => {
      e.preventDefault();
      isDraggingRef.current = true;
      map.dragPan.disable();
      map.getCanvas().style.cursor = "grabbing";
    };

    const onMapMouseMove = (e: maplibregl.MapMouseEvent): void => {
      if (!isDraggingRef.current) return;
      const pos: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      onPositionChangeRef.current(pos);
      pendingPosRef.current = pos;
      scheduleFire();
    };

    const onMapMouseUp = (): void => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
      // Make sure the latest dragged position is requested + committed.
      // Even if the throttle was about to fire, force one final call
      // synchronously so the commit doesn't race the timer.
      const finalPos = pendingPosRef.current;
      if (finalPos) {
        scheduledRef.current = false;
        pendingPosRef.current = null;
        void (async () => {
          const ctx = stateRef.current;
          if (!ctx) return;
          if (inflightRef.current) inflightRef.current.abort();
          const controller = new AbortController();
          inflightRef.current = controller;
          onStatusChangeRef.current("loading");
          try {
            const response = await fetchViaRoute(
              {
                fromCacheId: ctx.fromCacheId,
                toCacheId: ctx.toCacheId,
                via: finalPos,
              },
              controller.signal,
            );
            if (controller.signal.aborted) return;
            if (response.route) {
              latestRouteRef.current = response.route;
              onLiveChangeRef.current(response.route);
              onStatusChangeRef.current("ok");
              onCommitRef.current(response.route, finalPos);
            } else {
              onStatusChangeRef.current("nopath");
              // No commit on NoRoute — fall back to whatever was last
              // successfully previewed so the leg geometry stays valid.
              // Commit the previous position too — the marker should
              // snap back to where the last successful preview was for.
              if (latestRouteRef.current && stateRef.current) {
                onCommitRef.current(
                  latestRouteRef.current,
                  stateRef.current.position,
                );
              }
            }
          } catch (err) {
            if (controller.signal.aborted) return;
            console.warn(
              "[via-route] final fetch failed:",
              (err as Error).message,
            );
            // Commit the last successful preview if any — don't lose
            // the user's drag on a transient network blip.
            if (latestRouteRef.current && stateRef.current) {
              onCommitRef.current(
                latestRouteRef.current,
                stateRef.current.position,
              );
            }
          }
        })();
      } else if (latestRouteRef.current && stateRef.current) {
        // No new movement since the last successful request — commit
        // that one as the final at the current marker position.
        onCommitRef.current(latestRouteRef.current, stateRef.current.position);
      }
    };

    map.on("mousedown", LAYER_MARKER, onMarkerMouseDown);
    map.on("mousedown", LAYER_MARKER_RING, onMarkerMouseDown);
    map.on("mousemove", onMapMouseMove);
    map.on("mouseup", onMapMouseUp);
    // mouseup outside the canvas (e.g. user releases over the sidebar)
    // — listen on window so the drag still completes cleanly.
    const onWindowMouseUp = (): void => onMapMouseUp();
    window.addEventListener("mouseup", onWindowMouseUp);

    const onEnter = (): void => {
      if (!isDraggingRef.current) map.getCanvas().style.cursor = "grab";
    };
    const onLeave = (): void => {
      if (!isDraggingRef.current) map.getCanvas().style.cursor = "";
    };
    map.on("mouseenter", LAYER_MARKER, onEnter);
    map.on("mouseenter", LAYER_MARKER_RING, onEnter);
    map.on("mouseleave", LAYER_MARKER, onLeave);
    map.on("mouseleave", LAYER_MARKER_RING, onLeave);

    return () => {
      map.off("mousedown", LAYER_MARKER, onMarkerMouseDown);
      map.off("mousedown", LAYER_MARKER_RING, onMarkerMouseDown);
      map.off("mousemove", onMapMouseMove);
      map.off("mouseup", onMapMouseUp);
      window.removeEventListener("mouseup", onWindowMouseUp);
      map.off("mouseenter", LAYER_MARKER, onEnter);
      map.off("mouseenter", LAYER_MARKER_RING, onEnter);
      map.off("mouseleave", LAYER_MARKER, onLeave);
      map.off("mouseleave", LAYER_MARKER_RING, onLeave);
      if (isDraggingRef.current) {
        map.dragPan.enable();
        map.getCanvas().style.cursor = "";
        isDraggingRef.current = false;
      }
    };
    // We deliberately depend only on `state == null`-ness to mount/unmount
    // the listeners — the closures read the latest state through refs, so
    // mid-drag prop updates don't tear down the listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ready, state === null]);

  return null;
}

function upsert(
  map: maplibregl.Map,
  id: string,
  fc: GeoJSON.FeatureCollection,
): void {
  const existing = map.getSource(id);
  if (existing && "setData" in existing) {
    (existing as maplibregl.GeoJSONSource).setData(fc);
    return;
  }
  map.addSource(id, { type: "geojson", data: fc });
}
