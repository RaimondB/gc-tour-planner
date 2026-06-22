// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapContext, isMapStyleLive, type MapApi } from "./MapContext.js";
import { exposeMapForE2E } from "../../lib/test-helpers.js";

const DEFAULT_CENTER: [number, number] = [5.1214, 52.0907]; // Utrecht, NL — placeholder
const DEFAULT_ZOOM = 11;

/**
 * Opt-in map diagnostics (blank-map debugging). Enable on a device with either
 * `?mapdebug` in the URL or `localStorage['gctp:mapdebug']='1'`, then reload:
 * an on-screen overlay shows the map's lifecycle + errors (no remote console
 * needed). Lifecycle is always logged under `[map]` regardless (console.warn;
 * faults via console.error) so remote debugging works without the flag too.
 */
const MAP_DEBUG: boolean = (() => {
  try {
    if (typeof window === "undefined") return false;
    if (new URLSearchParams(window.location.search).has("mapdebug"))
      return true;
    return window.localStorage?.getItem("gctp:mapdebug") === "1";
  } catch {
    return false;
  }
})();

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
  // Bumping this rebuilds the map from scratch (keyed container below + effect
  // dep). The recovery path of last resort: when the WebGL context is lost and
  // the browser never fires `webglcontextrestored` (installed PWA backgrounded,
  // OS reclaimed the GPU), MapLibre leaves `map.style` null — repaint can't help,
  // the canvas is blank. On refocus we detect the dead style and recreate.
  const [recreateKey, setRecreateKey] = useState(0);
  // Last camera, so a recreate reopens where the user was (survives a dead style
  // — `getCenter/getZoom` read the transform, not the style).
  const cameraRef = useRef<{ center: [number, number]; zoom: number } | null>(
    null,
  );
  const onPickRef = useRef(onPickCenter);
  onPickRef.current = onPickCenter;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onViewportRef = useRef(onViewportChange);
  onViewportRef.current = onViewportChange;
  const onBasemapErrorRef = useRef(onBasemapError);
  onBasemapErrorRef.current = onBasemapError;

  // Diagnostics log buffer (only rendered when MAP_DEBUG). `logTick` forces the
  // overlay to re-render as lines arrive.
  const logsRef = useRef<string[]>([]);
  const [, setLogTick] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const logEvent = (msg: string, isError = false): void => {
      // eslint allows only warn/error; use warn for lifecycle, error for faults.
      (isError ? console.error : console.warn)(`[map] ${msg}`);
      if (!MAP_DEBUG) return;
      const t = new Date().toISOString().slice(11, 23);
      logsRef.current = [...logsRef.current.slice(-15), `${t} ${msg}`];
      setLogTick((n) => n + 1);
    };
    // Use `||`-style emptiness check, not `??`. Vite stamps unset Docker
    // build args into the bundle as empty strings rather than `undefined`,
    // so nullish-coalescing would let an empty URL through and MapLibre
    // would try to fetch it as a style.json (silent fail, no `load`).
    const styleEnv = import.meta.env.VITE_MAP_STYLE_URL as string | undefined;
    const styleSource =
      typeof styleEnv === "string" && styleEnv.length > 0
        ? styleEnv
        : FALLBACK_STYLE;
    // A recreate (recreateKey bump) reopens at the last camera, not the prop
    // defaults — so a context-loss recovery doesn't jump the user elsewhere.
    const startCamera = cameraRef.current;
    const map = new maplibregl.Map({
      container,
      style: styleSource,
      center: startCamera?.center ?? initialCenter,
      zoom: startCamera?.zoom ?? initialZoom,
      // Keep the WebGL backbuffer readable so we can snapshot the canvas
      // (map.getCanvas().toBlob) for a saved tour's offline preview (FR-W4).
      // Small always-on memory cost; required because the buffer is otherwise
      // cleared after each frame and toBlob would yield a blank image.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    // E2E-only handle (no-op unless VITE_E2E) so Playwright can read map state.
    exposeMapForE2E(map);
    {
      const c = map.getCanvas();
      const gl = c.getContext("webgl2") ?? c.getContext("webgl");
      logEvent(
        `construct style=${typeof styleSource === "string" ? styleSource || "(empty!)" : "fallback"} ` +
          `canvas=${c.width}x${c.height} webgl=${gl ? "ok" : "MISSING"} key=${recreateKey}`,
      );
    }
    const clickHandler = (e: maplibregl.MapMouseEvent) => {
      // Skip if the click hit a feature layer (those have their own
      // handlers). `map.getLayer` requires `map.style` to be loaded —
      // bound only after the `"load"` event below so this is safe.
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [
          "gctp-caches-circle",
          // The enlarged cache tap target (CachesLayer CACHES_HIT_LAYER) — a tap
          // landing here opens a cache popup, so it must NOT also move the
          // reticle/pick-center.
          "gctp-caches-hit",
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
      cameraRef.current = { center: [c.lng, c.lat], zoom: map.getZoom() };
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
    const onMapError = (e: { error?: { message?: string } }) => {
      tileErrorCount += 1;
      // Surface the actual failure — style/sprite/glyph/tile fetch errors are
      // the usual cause of a blank basemap and were previously swallowed.
      logEvent(`ERROR ${e?.error?.message ?? "(no message)"}`, true);
    };
    let loggedIdle = false;
    const onIdle = () => {
      if (tileErrorCount > 0) onBasemapErrorRef.current?.();
      // Log the first idle (and any idle after a tile error) with the telling
      // signals: did the style finish, is the canvas non-zero, is the map loaded.
      if (!loggedIdle || tileErrorCount > 0) {
        const c = map.getCanvas();
        logEvent(
          `idle styleLoaded=${map.isStyleLoaded()} loaded=${map.loaded()} ` +
            `canvas=${c.width}x${c.height} tileErr=${tileErrorCount}`,
        );
        loggedIdle = true;
      }
      tileErrorCount = 0;
    };
    map.on("error", onMapError);
    map.on("idle", onIdle);

    // WebGL context loss (installed PWA backgrounded → OS reclaims the GPU)
    // makes MapLibre destroy + null its style while the map object stays alive
    // and mounted. With `ready` still true, the next layer effect to run (e.g.
    // on app refocus) calls `map.getLayer` on the dead style and throws. Flip
    // `ready` so layers bail until the context is restored; on restore the
    // style is rebuilt, so flip back and force a re-measure/repaint. (See also
    // `isMapStyleLive` in MapContext, which guards the render path.)
    let contextLost = false;
    // If the context never gets restored (the backgrounded-PWA / GPU-reclaim
    // case — `webglcontextrestored` simply never fires), `map.style` stays null
    // and the canvas is blank. Recreate the map from scratch (last resort).
    // `getCenter`/`getZoom` still work (transform survives), so we reopen in
    // place. Guard with `isMapStyleLive` so we never recreate a healthy map.
    const recreateIfDead = (): boolean => {
      if (!contextLost || isMapStyleLive(map)) return false;
      logEvent("recreate: context lost + style dead → rebuilding map");
      try {
        const c = map.getCenter();
        cameraRef.current = { center: [c.lng, c.lat], zoom: map.getZoom() };
      } catch {
        /* transform unreadable — fall back to the last stored camera */
      }
      setRecreateKey((k) => k + 1);
      return true;
    };
    let recreateTimer: ReturnType<typeof setTimeout> | undefined;
    const onMapContextLost = () => {
      contextLost = true;
      logEvent("webglcontextLOST", true);
      setApi((prev) => (prev?.ready ? { map: prev.map, ready: false } : prev));
      // Foreground loss: give MapLibre a moment to restore on its own, then
      // recreate if it didn't. (Backgrounded loss is handled on refocus below,
      // since timers are throttled while hidden.)
      clearTimeout(recreateTimer);
      recreateTimer = setTimeout(() => {
        if (document.visibilityState === "visible") recreateIfDead();
      }, 1500);
    };
    const onMapContextRestored = () => {
      logEvent(`webglcontextRESTORED styleLoaded=${map.isStyleLoaded()}`);
      clearTimeout(recreateTimer);
      // MapLibre re-applies the saved style via setStyle() ASYNC on restore, so
      // the style isn't loaded yet. Flipping `ready` true now makes a layer
      // effect call addSource → "Style is not done loading." (the error screen).
      // Wait for the style to finish; keep `contextLost` true until then so the
      // recreate safety net still fires if the restore never actually completes.
      const reenable = () => {
        contextLost = false;
        logEvent(`reenable after restore styleLoaded=${map.isStyleLoaded()}`);
        setApi((prev) => (prev ? { map: prev.map, ready: true } : prev));
        map.resize();
        map.triggerRepaint();
      };
      if (map.isStyleLoaded()) reenable();
      else map.once("idle", reenable);
    };
    map.on("webglcontextlost", onMapContextLost);
    map.on("webglcontextrestored", onMapContextRestored);

    map.on("load", () => {
      logEvent(`load styleLoaded=${map.isStyleLoaded()}`);
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
      logEvent(
        `recover visible=${document.visibilityState} styleLive=${isMapStyleLive(map)} ` +
          `canvas=${map.getCanvas().width}x${map.getCanvas().height}`,
      );
      // A dead style (context lost, never restored) can't be repainted back —
      // recreate the map instead. Otherwise just re-measure/repaint.
      if (recreateIfDead()) return;
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
      clearTimeout(recreateTimer);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onWindowFocus);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      map.off("click", clickHandler);
      map.off("moveend", onMoveEnd);
      map.off("error", onMapError);
      map.off("idle", onIdle);
      map.off("webglcontextlost", onMapContextLost);
      map.off("webglcontextrestored", onMapContextRestored);
      onReadyRef.current?.(null);
      setApi(null);
      // React runs effect cleanups PARENT-FIRST on unmount, so this cleanup
      // fires BEFORE every child layer's cleanup. Those cleanups drop their
      // own layers/sources with `map.getLayer(id)` / `map.removeLayer(id)` —
      // and MapLibre's `getLayer` is `this.style.getLayer(id)`, which throws
      // "Cannot read properties of null (reading 'getLayer')" once `remove()`
      // has nulled `this.style`. Defer the teardown one microtask so every
      // child cleanup still sees a live map; the whole instance is torn down
      // immediately after this synchronous unmount flush completes.
      queueMicrotask(() => map.remove());
    };
    // Re-runs only when `recreateKey` bumps (context-loss recovery); pan/zoom is
    // user-driven otherwise. The keyed container below gives the rebuilt map a
    // fresh, empty div so the old (deferred) `map.remove()` can't race it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recreateKey]);

  return (
    <div key={recreateKey} ref={containerRef} className="map-view">
      {api ? (
        <MapContext.Provider value={api}>{children}</MapContext.Provider>
      ) : null}
      {MAP_DEBUG ? (
        <pre
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            zIndex: 9999,
            margin: 0,
            maxWidth: "92%",
            maxHeight: "45%",
            overflow: "auto",
            background: "rgba(0,0,0,0.78)",
            color: "#5dff7a",
            font: "10px/1.35 ui-monospace, monospace",
            padding: "4px 6px",
            whiteSpace: "pre-wrap",
            pointerEvents: "none",
            borderBottomRightRadius: 6,
          }}
        >
          {`map: api=${api ? (api.ready ? "ready" : "not-ready") : "null"}\n` +
            logsRef.current.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}
