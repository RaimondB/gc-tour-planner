// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState, type ReactNode } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapContext, type MapApi } from "./MapContext.js";

const DEFAULT_CENTER: [number, number] = [5.1214, 52.0907]; // Utrecht, NL — placeholder
const DEFAULT_ZOOM = 11;

const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
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
  children?: ReactNode;
}

export function MapView({
  initialCenter = DEFAULT_CENTER,
  initialZoom = DEFAULT_ZOOM,
  children,
}: MapViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [api, setApi] = useState<MapApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const style =
      (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) ??
      FALLBACK_STYLE;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center: initialCenter,
      zoom: initialZoom,
    });
    const ready = { current: false };
    map.on("load", () => {
      ready.current = true;
      setApi({ map, ready: true });
    });
    setApi({ map, ready: false });
    return () => {
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
