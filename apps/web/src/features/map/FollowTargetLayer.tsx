// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import { useMap } from "./MapContext.js";
import { applyLayerOrder } from "./map-layers.js";

const SOURCE = "gctp-follow-target-src";
const RING_LAYER = "gctp-follow-target-ring";

function upsert(
  map: maplibregl.Map,
  id: string,
  data: GeoJSON.FeatureCollection,
): void {
  const existing = map.getSource(id);
  if (existing && "setData" in existing) {
    (existing as maplibregl.GeoJSONSource).setData(data);
  } else {
    map.addSource(id, { type: "geojson", data });
  }
}

/**
 * Highlights the current follow-mode target stop with a bold ring so the user
 * can spot "the one I'm heading to" among the numbered stops (ADR-location).
 * `target` null clears it. The actual route + stop numbers render via TourLayer.
 */
export function FollowTargetLayer({
  target,
}: {
  target: [number, number] | null;
}): null {
  const { map, ready } = useMap();

  useEffect(() => {
    if (!ready) return;
    const fc: GeoJSON.FeatureCollection = target
      ? {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: target },
            },
          ],
        }
      : { type: "FeatureCollection", features: [] };

    upsert(map, SOURCE, fc);
    if (!map.getLayer(RING_LAYER)) {
      map.addLayer({
        id: RING_LAYER,
        type: "circle",
        source: SOURCE,
        paint: {
          "circle-radius": 16,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#f59e0b",
          "circle-stroke-width": 3,
        },
      });
    }
    applyLayerOrder(map);
  }, [map, ready, target]);

  return null;
}
