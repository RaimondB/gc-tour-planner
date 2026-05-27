// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import type maplibregl from "maplibre-gl";
import { useQuery } from "@tanstack/react-query";
import { fetchParkingOptions } from "../../lib/api.js";
import type { SelectedParking } from "./CachesLayer.js";
import { useMap } from "./MapContext.js";

const SOURCE_ID = "gctp-parking-preview";
const LINE_LAYER = "gctp-parking-preview-line";
/** Wider invisible hitbox so the user doesn't need pixel-perfect clicks. */
const HIT_LAYER = "gctp-parking-preview-hit";

/**
 * Fetches walking previews from each parking candidate near the cluster
 * to its nearest cache, and renders them as dashed lines beneath the
 * main tour polyline. Lets the user compare parking options at a glance.
 *
 * Bogus options (OSRM walk > `maxWalkingMeters`, almost always an OSM
 * data gap) render red so the user can still see them and pick a better
 * candidate.
 *
 * Clicking a preview line drives the parent's `onParkingSelect` callback;
 * the standalone `ParkingOwnerLinkLayer` renders the resulting owner
 * link. Same machinery as clicking a parking marker in `CachesLayer`.
 */
export function ParkingPreviewLayer({
  cacheIds,
  maxWalkingMeters,
  onParkingSelect,
}: {
  cacheIds: readonly number[];
  /** Cap on OSRM walking distance; matches the planner's `maxLinkMeters`. */
  maxWalkingMeters?: number;
  onParkingSelect?: (next: SelectedParking | null) => void;
}): null {
  const { map, ready } = useMap();

  const query = useQuery({
    queryKey: [
      "parking-options",
      [...cacheIds].sort((a, b) => a - b),
      maxWalkingMeters ?? null,
    ],
    queryFn: () =>
      fetchParkingOptions({
        cacheIds: [...cacheIds],
        maxOptions: 8,
        maxWalkingMeters,
      }),
    enabled: cacheIds.length > 0,
    staleTime: 5 * 60_000, // parking + osrm don't change mid-session
  });

  useEffect(() => {
    if (!ready) return;

    const options = query.data?.options ?? [];
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: options.map((opt) => ({
        type: "Feature",
        properties: {
          id: opt.id,
          walkingMeters: opt.walkingMeters,
          nearestCacheId: opt.nearestCacheId,
          ownerCacheId: opt.ownerCacheId,
          parkingLng: opt.point[0],
          parkingLat: opt.point[1],
          bogus: opt.bogus,
        },
        geometry: opt.polyline,
      })),
    };

    const existing = map.getSource(SOURCE_ID);
    if (existing && "setData" in existing) {
      (existing as maplibregl.GeoJSONSource).setData(fc);
    } else {
      map.addSource(SOURCE_ID, { type: "geojson", data: fc });
    }

    if (!map.getLayer(LINE_LAYER)) {
      // Render below the main tour polyline so the chosen tour stays
      // visually dominant. Bogus options (over the walking cap) render
      // red so the user can see them but knows they're not real walks.
      map.addLayer(
        {
          id: LINE_LAYER,
          type: "line",
          source: SOURCE_ID,
          paint: {
            "line-color": [
              "case",
              ["==", ["get", "bogus"], true],
              "#e53935",
              "#1e88e5",
            ],
            "line-width": 2.5,
            "line-opacity": 0.55,
            "line-dasharray": [2, 1.5],
          },
        },
        firstTourLayer(map),
      );
    }
    if (!map.getLayer(HIT_LAYER)) {
      // Invisible wide hitbox stacked on top — gives the click target
      // some pixel slack without making the visible dashed line look
      // thick.
      map.addLayer({
        id: HIT_LAYER,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": "#000",
          "line-width": 14,
          "line-opacity": 0,
        },
      });
    }
  }, [map, ready, query.data]);

  // Tear down when cacheIds clears so the previews disappear with the
  // cluster selection rather than lingering.
  useEffect(() => {
    if (!ready) return;
    if (cacheIds.length === 0) {
      if (map.getLayer(HIT_LAYER)) map.removeLayer(HIT_LAYER);
      if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }
  }, [map, ready, cacheIds.length]);

  // Click handler: report the parking → owner-cache association to the
  // parent. Uses a global click + queryRenderedFeatures so it survives
  // the teardown effect removing/re-adding HIT_LAYER (layer-bound
  // listeners can otherwise miss events).
  useEffect(() => {
    if (!ready || !onParkingSelect) return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(HIT_LAYER)) return;
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [HIT_LAYER],
      });
      const f = hits[0];
      if (!f) return;
      const props = f.properties as {
        ownerCacheId?: number;
        parkingLng?: number;
        parkingLat?: number;
      };
      if (
        typeof props.ownerCacheId !== "number" ||
        typeof props.parkingLng !== "number" ||
        typeof props.parkingLat !== "number"
      ) {
        return;
      }
      onParkingSelect({
        point: [props.parkingLng, props.parkingLat],
        ownerCacheId: props.ownerCacheId,
      });
    };
    const onMove = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(HIT_LAYER)) return;
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [HIT_LAYER],
      });
      if (hits.length > 0) map.getCanvas().style.cursor = "pointer";
    };
    map.on("click", onClick);
    map.on("mousemove", onMove);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
    };
  }, [map, ready, onParkingSelect]);

  return null;
}

/**
 * Place the preview lines just below the chosen-tour polyline (if any)
 * so the user sees the picked tour layered on top. Falls back to the
 * default top of the layer stack if the tour layer isn't mounted yet.
 */
function firstTourLayer(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle().layers ?? [];
  for (const id of ["gctp-tour-line", "gctp-clusters-preview-line"]) {
    if (layers.some((l) => l.id === id)) return id;
  }
  return undefined;
}
