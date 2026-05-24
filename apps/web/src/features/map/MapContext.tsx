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

export function useMap(): MapApi {
  const ctx = useContext(MapContext);
  if (!ctx) throw new Error("useMap() must be called inside a <MapView>");
  return ctx;
}
