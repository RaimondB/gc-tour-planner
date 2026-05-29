// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import type { PlanResult } from "@gctp/shared/tours";
import { useMap } from "./MapContext.js";

const SOURCE_ID = "gctp-leg-alt-preview";
const LINE_LAYER = "gctp-leg-alt-preview-line";

/**
 * Renders a semi-transparent dashed preview of an alternative leg
 * geometry while the user is browsing the alternatives panel — sits
 * on top of the applied tour polyline so it's visually clear which
 * candidate the user is hovering / radio-selecting before applying.
 *
 * Driven entirely by props from `App.tsx`. When `previewAlternativeIndex`
 * is `null` (no preview active) the source is cleared.
 */
export function LegAlternativePreviewLayer({
  result,
  selectedLegIndex,
  previewAlternativeIndex,
}: {
  result: PlanResult | null;
  selectedLegIndex: number | null;
  previewAlternativeIndex: number | null;
}): null {
  const { map, ready } = useMap();

  useEffect(() => {
    if (!ready) return;
    const leg =
      result && selectedLegIndex !== null
        ? result.legs[selectedLegIndex]
        : undefined;
    const alt =
      leg && previewAlternativeIndex !== null
        ? leg.alternatives[previewAlternativeIndex]
        : undefined;

    const fc: GeoJSON.FeatureCollection = alt
      ? {
          type: "FeatureCollection",
          features: [
            { type: "Feature", geometry: alt.geometry, properties: {} },
          ],
        }
      : { type: "FeatureCollection", features: [] };

    const existing = map.getSource(SOURCE_ID);
    if (existing && "setData" in existing) {
      (existing as maplibregl.GeoJSONSource).setData(fc);
    } else {
      map.addSource(SOURCE_ID, { type: "geojson", data: fc });
    }

    if (!map.getLayer(LINE_LAYER)) {
      map.addLayer({
        id: LINE_LAYER,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#1976d2",
          "line-width": 4,
          "line-opacity": 0.85,
          "line-dasharray": [1.5, 1.2],
        },
      });
    }
    // Keep the preview above the tour line so it's always visible
    // — moveLayer to top whenever we re-render.
    if (map.getLayer(LINE_LAYER)) map.moveLayer(LINE_LAYER);
  }, [map, ready, result, selectedLegIndex, previewAlternativeIndex]);

  return null;
}
