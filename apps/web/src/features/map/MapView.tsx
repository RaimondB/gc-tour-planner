// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapContext, type MapApi } from "./MapContext.js";
import { exposeMapForE2E } from "../../lib/test-helpers.js";

const DEFAULT_CENTER: [number, number] = [5.1214, 52.0907]; // Utrecht, NL — placeholder
const DEFAULT_ZOOM = 11;

const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  // Without `glyphs`, MapLibre silently drops every `symbol` layer's
  // text-field — that's why the parking "P" label and the tour visit-order
  // numbers / direction arrows would refuse to render. Demotiles serves
  // Open Sans glyph PBFs free for development; production deployments
  // should set VITE_MAP_STYLE_URL to a hosted style that bundles its own
  // glyphs.
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

export interface MapViewProps {
  /** Initial center; the map is uncontrolled afterwards (user pans/zooms freely). */
  initialCenter?: [number, number];
  initialZoom?: number;
  /**
   * Fires on a left-click on the map background (i.e. not on top of an
   * interactive feature like a cache marker). Use to pick a new search center
   * — the camera intentionally does not jump; the user already chose the
   * location visually.
   */
  onPickCenter?: (lngLat: [number, number]) => void;
  /**
   * Fires once when the map instance is created and again with `null` on
   * unmount. Use to grab a ref for imperative camera moves like flyTo.
   */
  onReady?: (map: maplibregl.Map | null) => void;
  /**
   * Fires on `moveend` (debounced) with the current center + zoom. Use
   * to persist the viewport so a refresh restores the user's spot.
   */
  onViewportChange?: (viewport: {
    center: [number, number];
    zoom: number;
  }) => void;
  /**
   * Fires (at most once per render cycle) when basemap tiles fail to load — a
   * fast local hint that we may be offline. The caller confirms with an
   * authoritative connectivity probe before swapping in the offline snapshot.
   */
  onBasemapError?: () => void;
  children?: ReactNode;
}

export function MapView({
  initialCenter = DEFAULT_CENTER,
  initialZoom = DEFAULT_ZOOM,
  onPickCenter,
  onReady,
  onViewportChange,
  onBasemapError,
  children,
}: MapViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [api, setApi] = useState<MapApi | null>(null);
  const onPickRef = useRef(onPickCenter);
  onPickRef.current = onPickCenter;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onViewportRef = useRef(onViewportChange);
  onViewportRef.current = onViewportChange;
  const onBasemapErrorRef = useRef(onBasemapError);
  onBasemapErrorRef.current = onBasemapError;

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    // Use `||`-style emptiness check, not `??`. Vite stamps unset Docker
    // build args into the bundle as empty strings rather than `undefined`,
    // so nullish-coalescing would let an empty URL through and MapLibre
    // would try to fetch it as a style.json (silent fail, no `load`).
    const styleEnv = import.meta.env.VITE_MAP_STYLE_URL as string | undefined;
    const styleSource =
      typeof styleEnv === "string" && styleEnv.length > 0
        ? styleEnv
        : FALLBACK_STYLE;
    const map = new maplibregl.Map({
      container,
      style: styleSource,
      center: initialCenter,
      zoom: initialZoom,
      // Keep the WebGL backbuffer readable so we can snapshot the canvas
      // (map.getCanvas().toBlob) for a saved tour's offline preview (FR-W4).
      // Small always-on memory cost; required because the buffer is otherwise
      // cleared after each frame and toBlob would yield a blank image.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    // E2E-only handle (no-op unless VITE_E2E) so Playwright can read map state.
    exposeMapForE2E(map);
    const clickHandler = (e: maplibregl.MapMouseEvent) => {
      // Skip if the click hit a feature layer (those have their own
      // handlers). `map.getLayer` requires `map.style` to be loaded —
      // bound only after the `"load"` event below so this is safe.
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [
          "gctp-caches-circle",
          "gctp-parking-preview-hit",
          "gctp-cluster-centroids-circle",
          "gctp-osm-parking-fill",
          "gctp-osm-parking-point",
          "gctp-osm-parking-label",
        ].filter((id) => map.getLayer(id)),
      });
      if (hits.length > 0) return;
      onPickRef.current?.([e.lngLat.lng, e.lngLat.lat]);
    };

    // Persist the user's viewport on moveend so a refresh restores the
    // same spot. moveend already fires after pan/zoom settle, so no
    // extra debouncing needed.
    const onMoveEnd = () => {
      const c = map.getCenter();
      onViewportRef.current?.({
        center: [c.lng, c.lat],
        zoom: map.getZoom(),
      });
    };
    // Tile-failure hint: tally tile/source load errors per render cycle and, if
    // any occurred, ping the caller ONCE at `idle` to re-check connectivity.
    // This only nudges an authoritative probe — it never decides offline itself
    // (a cached tile is indistinguishable from being online), so it can't flap.
    let tileErrorCount = 0;
    const onMapError = () => {
      tileErrorCount += 1;
    };
    const onIdle = () => {
      if (tileErrorCount > 0) onBasemapErrorRef.current?.();
      tileErrorCount = 0;
    };
    map.on("error", onMapError);
    map.on("idle", onIdle);

    map.on("load", () => {
      map.on("click", clickHandler);
      map.on("moveend", onMoveEnd);
      setApi({ map, ready: true });
    });
    setApi({ map, ready: false });
    onReadyRef.current?.(map);

    // MapLibre measures its container ONCE at construction time. Grid
    // layouts often settle on a later tick, so a ResizeObserver pokes
    // MapLibre to re-measure whenever the parent's real size changes —
    // otherwise the map can end up thinking it has zero pixels and
    // never fire any tile or glyph requests.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container);

    // Tab-visibility recovery. When the tab is backgrounded the
    // browser pauses requestAnimationFrame, MapLibre's render loop
    // halts, and tiles that arrive during that pause never paint.
    // Coming back to the tab leaves the basemap stale (or blank) while
    // overlays — which redraw on React state changes — look fine.
    // Forcing a resize + repaint on `visibilitychange` covers it.
    // `pageshow` with `persisted=true` covers the BFCache restore case
    // (mobile Safari especially).
    const recover = () => {
      map.resize();
      map.triggerRepaint();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      recover();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) recover();
    };
    // Switching to ANOTHER APP (not another tab) blurs the window without
    // changing `document.visibilityState`, so `visibilitychange` never fires
    // — yet the browser still pauses rAF for the unfocused window, leaving the
    // basemap stale/blank on return. `window` focus covers that gap.
    const onWindowFocus = () => recover();
    // If the OS / browser reclaimed GPU memory while backgrounded the WebGL
    // context is lost and the canvas comes back blank; repaint once it's
    // restored. (Belt-and-braces for the memory-pressure discard case.)
    const canvas = map.getCanvas();
    const onContextRestored = () => recover();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onWindowFocus);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    return () => {
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onWindowFocus);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      map.off("click", clickHandler);
      map.off("moveend", onMoveEnd);
      map.off("error", onMapError);
      map.off("idle", onIdle);
      onReadyRef.current?.(null);
      map.remove();
      setApi(null);
    };
    // Effect runs once per mount; pan/zoom is user-driven after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={containerRef} className="map-view">
      {api ? (
        <MapContext.Provider value={api}>{children}</MapContext.Provider>
      ) : null}
    </div>
  );
}
