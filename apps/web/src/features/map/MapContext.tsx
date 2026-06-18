// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { createContext, useContext } from "react";
import type maplibregl from "maplibre-gl";

/**
 * Wraps the active MapLibre instance plus a "loaded" flag. Layer components
 * read this to attach sources / layers safely (waiting for first `load`),
 * without each child re-creating its own map ref.
 */
export interface MapApi {
  map: maplibregl.Map;
  ready: boolean;
}

export const MapContext = createContext<MapApi | null>(null);

/**
 * True when the map still has a live style. MapLibre nulls `map.style` BOTH on
 * `remove()` AND during a WebGL context-loss window — the latter happens
 * routinely when an installed PWA is backgrounded and the OS reclaims GPU memory
 * (MapLibre's `webglcontextlost` handler runs `this.style.destroy(); this.style
 * = null`). Every style op routes through it (`map.getLayer(id)` is literally
 * `this.style.getLayer(id)`), so any call on a null style throws
 * `Cannot read properties of null (reading 'getLayer')`. The map object itself
 * stays alive and mounted, so `ready` can still be `true` — guard with this.
 */
export function isMapStyleLive(map: maplibregl.Map): boolean {
  return Boolean((map as unknown as { style?: unknown }).style);
}

export function useMap(): MapApi {
  const ctx = useContext(MapContext);
  if (!ctx) throw new Error("useMap() must be called inside a <MapView>");
  // Treat a map whose style has gone away (removed, or WebGL context lost) as
  // not-ready, so every layer's `if (!ready) return` short-circuits before it
  // touches the dead style. This is re-evaluated on each render, so a focus /
  // refetch re-render after a backgrounded context loss sees `ready: false`.
  if (ctx.ready && !isMapStyleLive(ctx.map)) {
    return { map: ctx.map, ready: false };
  }
  return ctx;
}
