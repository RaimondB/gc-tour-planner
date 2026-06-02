// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import type { CacheSummaryDTO } from "@gctp/shared/caches";
import type { SelectedParking } from "./CachesLayer.js";
import { useMap } from "./MapContext.js";

const SOURCE_ID = "gctp-parking-owner-link";
const LAYER_ID = "gctp-parking-owner-link-line";

/**
 * Yellow dotted straight-line connector from the most recently clicked
 * parking spot to the cache whose GPX listed it. A parking often serves
 * multiple caches in the same cluster; making the "this parking is for
 * cache X" association visible helps the user assemble a tour from
 * fragmented parking metadata.
 *
 * Driven by `selectedParking` state owned by the parent — set from
 * either a parking-marker click (CachesLayer) or a parking-preview-line
 * click (ParkingPreviewLayer). `null` clears the line.
 */
export function ParkingOwnerLinkLayer({
  selectedParking,
  caches,
}: {
  selectedParking: SelectedParking | null;
  caches?: readonly CacheSummaryDTO[];
}): null {
  const { map, ready } = useMap();

  useEffect(() => {
    if (!ready) return;
    const owner = selectedParking
      ? caches?.find((c) => c.id === selectedParking.ownerCacheId)
      : undefined;

    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features:
        selectedParking && owner
          ? [
              {
                type: "Feature",
                properties: { ownerCacheId: selectedParking.ownerCacheId },
                geometry: {
                  type: "LineString",
                  coordinates: [
                    selectedParking.point,
                    owner.location.coordinates as [number, number],
                  ],
                },
              },
            ]
          : [],
    };

    const existing = map.getSource(SOURCE_ID);
    if (existing && "setData" in existing) {
      (existing as maplibregl.GeoJSONSource).setData(fc);
    } else {
      map.addSource(SOURCE_ID, { type: "geojson", data: fc });
    }
    if (!map.getLayer(LAYER_ID)) {
      map.addLayer({
        id: LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": "#f9a825",
          "line-width": 2.5,
          "line-opacity": 0.9,
          "line-dasharray": [1, 2],
        },
      });
    }
  }, [map, ready, selectedParking, caches]);

  return null;
}
