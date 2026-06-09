// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import type { SearchParams } from "../../lib/search-params.js";
import { useMap } from "./MapContext.js";

const SOURCE_ID = "gctp-radius";
const LINE_LAYER = "gctp-radius-line";
const CENTER_SOURCE = "gctp-search-center";
const CENTER_LAYER = "gctp-search-center-dot";

/**
 * Draws a circle around the current search center plus a dot at the center.
 * The circle is approximated as a 64-vertex polygon — accurate to a few meters
 * at any reasonable search radius and cheap enough to regenerate on every
 * params change.
 *
 * `interactive` (the "Find caches" step) makes the circle prominent and the
 * center dot a draggable handle for repositioning the search center. Outside
 * that step the circle is dimmed, non-interactive context — so a stray map
 * click never shifts an area the user has already clustered.
 */
export function RadiusLayer({
  params,
  interactive = false,
  onCenterChange,
}: {
  params: SearchParams;
  interactive?: boolean;
  /** Called when the user drags the center handle to a new position. */
  onCenterChange?: (center: [number, number]) => void;
}): null {
  const { map, ready } = useMap();

  useEffect(() => {
    if (!ready) return;

    const polygon = circlePolygon(params.center, params.radiusM);
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: polygon, properties: {} }],
    };
    const centerFc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: params.center },
          properties: {},
        },
      ],
    };

    upsert(map, SOURCE_ID, fc);
    upsert(map, CENTER_SOURCE, centerFc);

    if (!map.getLayer(LINE_LAYER)) {
      map.addLayer(
        {
          id: LINE_LAYER,
          type: "line",
          source: SOURCE_ID,
          paint: {
            "line-color": "#2563eb",
            "line-width": 1.5,
            "line-dasharray": [4, 2],
          },
        },
        firstSymbolOrCachesLayer(map),
      );
    }
    if (!map.getLayer(CENTER_LAYER)) {
      map.addLayer({
        id: CENTER_LAYER,
        type: "circle",
        source: CENTER_SOURCE,
        paint: {
          "circle-radius": 5,
          "circle-color": "#2563eb",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
    }
    return undefined;
  }, [map, ready, params.center, params.radiusM]);

  // Prominence: bright + grabbable handle in the "Find caches" step; dimmed,
  // smaller, ignored otherwise. Re-applied whenever `interactive` flips.
  useEffect(() => {
    if (!ready) return;
    if (map.getLayer(LINE_LAYER)) {
      map.setPaintProperty(
        LINE_LAYER,
        "line-opacity",
        interactive ? 0.9 : 0.35,
      );
      map.setPaintProperty(LINE_LAYER, "line-width", interactive ? 1.8 : 1.2);
    }
    if (map.getLayer(CENTER_LAYER)) {
      map.setPaintProperty(CENTER_LAYER, "circle-radius", interactive ? 8 : 4);
      map.setPaintProperty(
        CENTER_LAYER,
        "circle-opacity",
        interactive ? 1 : 0.4,
      );
      map.setPaintProperty(
        CENTER_LAYER,
        "circle-stroke-opacity",
        interactive ? 1 : 0.4,
      );
    }
  }, [map, ready, interactive]);

  // Draggable center handle — active only in the interactive (step 1) state.
  useEffect(() => {
    if (!ready || !interactive || !onCenterChange) return;
    if (!map.getLayer(CENTER_LAYER)) return;

    let dragging = false;

    const moveTo = (lngLat: maplibregl.LngLat) => {
      const center: [number, number] = [lngLat.lng, lngLat.lat];
      const centerSrc = map.getSource(CENTER_SOURCE);
      const ringSrc = map.getSource(SOURCE_ID);
      if (centerSrc && "setData" in centerSrc) {
        (centerSrc as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: center },
              properties: {},
            },
          ],
        });
      }
      if (ringSrc && "setData" in ringSrc) {
        (ringSrc as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: circlePolygon(center, params.radiusM),
              properties: {},
            },
          ],
        });
      }
    };

    const onDown = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      e.preventDefault(); // stop the map from panning under the drag
      dragging = true;
      map.getCanvas().style.cursor = "grabbing";
    };
    const onMove = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (!dragging) return;
      moveTo(e.lngLat);
    };
    const onUp = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (!dragging) return;
      dragging = false;
      map.getCanvas().style.cursor = "";
      onCenterChange([e.lngLat.lng, e.lngLat.lat]);
    };
    const onEnter = () => {
      if (!dragging) map.getCanvas().style.cursor = "grab";
    };
    const onLeave = () => {
      if (!dragging) map.getCanvas().style.cursor = "";
    };

    map.on("mousedown", CENTER_LAYER, onDown);
    map.on("touchstart", CENTER_LAYER, onDown);
    map.on("mousemove", onMove);
    map.on("touchmove", onMove);
    map.on("mouseup", onUp);
    map.on("touchend", onUp);
    map.on("mouseenter", CENTER_LAYER, onEnter);
    map.on("mouseleave", CENTER_LAYER, onLeave);
    return () => {
      map.off("mousedown", CENTER_LAYER, onDown);
      map.off("touchstart", CENTER_LAYER, onDown);
      map.off("mousemove", onMove);
      map.off("touchmove", onMove);
      map.off("mouseup", onUp);
      map.off("touchend", onUp);
      map.off("mouseenter", CENTER_LAYER, onEnter);
      map.off("mouseleave", CENTER_LAYER, onLeave);
      map.getCanvas().style.cursor = "";
    };
  }, [map, ready, interactive, onCenterChange, params.radiusM]);

  return null;
}

function upsert(
  map: maplibregl.Map,
  id: string,
  data: GeoJSON.FeatureCollection,
): void {
  const existing = map.getSource(id);
  if (existing && "setData" in existing) {
    (existing as maplibregl.GeoJSONSource).setData(data);
    return;
  }
  map.addSource(id, { type: "geojson", data });
}

/**
 * Place the radius layers below the cache markers so markers stay clickable
 * and visible. Returns undefined if no caches layer exists yet — MapLibre
 * then appends to the top, which is fine for the first paint.
 */
function firstSymbolOrCachesLayer(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle().layers ?? [];
  const cachesLayer = layers.find((l) => l.id === "gctp-caches-circle");
  return cachesLayer?.id;
}

function circlePolygon(
  center: [number, number],
  radiusM: number,
  steps = 64,
): GeoJSON.Polygon {
  const [lng, lat] = center;
  const earthR = 6_378_137; // WGS84 mean radius in meters
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    const dx = radiusM * Math.cos(angle);
    const dy = radiusM * Math.sin(angle);
    const dLat = (dy / earthR) * (180 / Math.PI);
    const dLng = ((dx / earthR) * (180 / Math.PI)) / cosLat;
    ring.push([lng + dLng, lat + dLat]);
  }
  return { type: "Polygon", coordinates: [ring] };
}
