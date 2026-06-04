// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import maplibregl from "maplibre-gl";
import { useQuery } from "@tanstack/react-query";
import type {
  ParkingAccessChip,
  ParkingFacilityFeature,
  ParkingFeeFilter,
} from "@gctp/shared/parking-facilities";
import { listParkingFacilities } from "../../lib/api.js";
import { useMap } from "./MapContext.js";
import { PARKING_MIN_ZOOM } from "./parking-zoom.js";
import { useViewportBbox } from "./useViewportBbox.js";

const SOURCE_ID = "gctp-osm-parking";
const FILL_LAYER = "gctp-osm-parking-fill";
const OUTLINE_LAYER = "gctp-osm-parking-line";
const POINT_LAYER = "gctp-osm-parking-point";
const LABEL_LAYER = "gctp-osm-parking-label";

// All zooms anchored on PARKING_MIN_ZOOM so this layer and CachesLayer's
// cache-owner parking pins always pop in together. Internal progression:
//   PARKING_MIN_ZOOM       → fetch + node circles
//   PARKING_MIN_ZOOM + 1   → polygon fill + outline
//   PARKING_MIN_ZOOM + 2   → "P" / "P€" text labels
const MIN_ZOOM_POINT = PARKING_MIN_ZOOM;
const MIN_ZOOM_POLY = PARKING_MIN_ZOOM + 1;
const MIN_ZOOM_LABEL = PARKING_MIN_ZOOM + 2;
const FETCH_MIN_ZOOM = PARKING_MIN_ZOOM;

/**
 * Renders OSM `amenity=parking` features (ADR-0011) in whatever's
 * currently visible in the map viewport — fetches on `moveend` so the
 * user sees parking in any area they pan into, not just inside the
 * search radius. Skipped below z12 (would be tens of thousands of rows
 * for very little visual benefit).
 *
 * Styled by access + fee so the user can tell free / paid / customers /
 * permit at a glance:
 *
 *   * fee=no  + access=yes  → green   (free public)
 *   * fee=yes + access=yes  → blue    (paid public, "P€" label)
 *   * access=customers      → grey
 *   * access=permit         → orange
 *
 * The sidebar's access + fee filters are applied **server-side** — only
 * the currently-eligible features reach the map. This is intentional:
 * permit + private + null cover thousands of features in a dense urban
 * viewport, and rendering them all caused MapLibre layout pain. To see
 * permit-only parkings, toggle the `permit` chip on.
 *
 * Clicking a feature opens a popup with the OSM tags relevant to a
 * geocacher: capacity, maxstay, opening_hours, supervised, surface, name.
 */
export function OsmParkingLayer({
  access,
  fee,
}: {
  /** Eligible access values; passed through to /parking-facilities. */
  access?: readonly ParkingAccessChip[];
  /** Fee preference; passed through to /parking-facilities. */
  fee?: ParkingFeeFilter;
}): null {
  const { map, ready } = useMap();
  // 0.02° ≈ a city neighborhood — small enough to keep payloads tight,
  // large enough that nearby pans don't refetch.
  const bbox = useViewportBbox({
    minZoom: FETCH_MIN_ZOOM,
    gridDeg: 0.02,
    debounceMs: 400,
  });

  // Server-side filter so we don't ship tens of thousands of permit /
  // private / unknown rows to the browser at city zoom. Permits surface
  // when the user opts in via the sidebar chip.
  const query = useQuery({
    queryKey: ["osm-parking", bbox, access ?? null, fee ?? null],
    queryFn: () =>
      listParkingFacilities({
        bbox: bbox!,
        access,
        fee,
      }),
    enabled: bbox !== null,
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });

  // Push features → source; create the four render layers on first run.
  useEffect(() => {
    if (!ready) return;
    // Below `FETCH_MIN_ZOOM`, `bbox` becomes null and the query is
    // gated off — clear the source so the previously-fetched parkings
    // don't keep rendering on a zoomed-out view that no longer fetches.
    const features = bbox === null ? [] : (query.data?.features ?? []);
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: features.map((f) => featureWithStyling(f)),
    };

    const existing = map.getSource(SOURCE_ID);
    if (existing && "setData" in existing) {
      (existing as maplibregl.GeoJSONSource).setData(fc);
    } else {
      map.addSource(SOURCE_ID, { type: "geojson", data: fc });
    }

    if (!map.getLayer(FILL_LAYER)) {
      map.addLayer({
        id: FILL_LAYER,
        type: "fill",
        source: SOURCE_ID,
        minzoom: MIN_ZOOM_POLY,
        filter: ["==", ["get", "isPoint"], false],
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": 0.35,
        },
      });
    }
    if (!map.getLayer(OUTLINE_LAYER)) {
      map.addLayer({
        id: OUTLINE_LAYER,
        type: "line",
        source: SOURCE_ID,
        minzoom: MIN_ZOOM_POLY,
        filter: ["==", ["get", "isPoint"], false],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 1.8,
          "line-opacity": 0.95,
        },
      });
    }
    if (!map.getLayer(POINT_LAYER)) {
      map.addLayer({
        id: POINT_LAYER,
        type: "circle",
        source: SOURCE_ID,
        minzoom: MIN_ZOOM_POINT,
        filter: ["==", ["get", "isPoint"], true],
        paint: {
          "circle-radius": 6,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-opacity": 0.95,
        },
      });
    }
    if (!map.getLayer(LABEL_LAYER)) {
      map.addLayer({
        id: LABEL_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        minzoom: MIN_ZOOM_LABEL,
        layout: {
          "text-field": ["get", "label"],
          "text-size": 12,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": "#212121",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });
    }
  }, [map, ready, query.data, bbox]);

  // Global click + queryRenderedFeatures pattern — same as
  // ParkingPreviewLayer. Survives layer remove/re-add cycles and isn't
  // sensitive to listener-attach timing.
  useEffect(() => {
    if (!ready) return;
    const pickLayers = () =>
      [FILL_LAYER, OUTLINE_LAYER, POINT_LAYER, LABEL_LAYER].filter((id) =>
        map.getLayer(id),
      );
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const layers = pickLayers();
      if (layers.length === 0) return;
      const hits = map.queryRenderedFeatures(e.point, { layers });
      const f = hits[0];
      if (!f) return;
      const props = f.properties as ParkingFeaturePopupProps;
      new maplibregl.Popup({ closeButton: true })
        .setLngLat(e.lngLat)
        .setHTML(popupHtml(props))
        .addTo(map);
    };
    const onMove = (e: maplibregl.MapMouseEvent) => {
      const layers = pickLayers();
      if (layers.length === 0) return;
      const hits = map.queryRenderedFeatures(e.point, { layers });
      if (hits.length > 0) map.getCanvas().style.cursor = "pointer";
    };
    map.on("click", onClick);
    map.on("mousemove", onMove);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
    };
  }, [map, ready]);

  return null;
}

interface ParkingFeaturePopupProps {
  osmId: number;
  osmType: string;
  access: string | null;
  fee: string | null;
  parkingType: string | null;
  capacity: number | null;
  maxstay: string | null;
  supervised: string | null;
  openingHours: string | null;
  surface: string | null;
  name: string | null;
}

function featureWithStyling(
  f: ParkingFacilityFeature,
): GeoJSON.Feature<GeoJSON.Geometry> {
  const isPoint = f.geometry.type === "Point";
  return {
    type: "Feature",
    properties: {
      ...f.properties,
      isPoint,
      color: colorFor(f.properties.access, f.properties.fee),
      label: labelFor(f.properties.fee),
    },
    geometry: f.geometry,
  };
}

function colorFor(access: string | null, fee: string | null): string {
  const a = access ?? "";
  if (a === "yes") return fee === "yes" ? "#1e88e5" : "#43a047";
  if (a === "customers") return "#757575";
  if (a === "permit") return "#ef6c00";
  // private / no / destination / unknown — kept visible but faded red.
  return "#e53935";
}

function labelFor(fee: string | null): string {
  if (fee === "yes") return "P€";
  return "P";
}

function popupHtml(p: ParkingFeaturePopupProps): string {
  // MapLibre strips `null` properties from features when serialising
  // through the GeoJSON source — so a column that was `null` in the DB
  // arrives as `undefined` on the click feature, not `null`. Use loose
  // equality below to catch both, and an `escape` helper that no-ops on
  // missing strings.
  const rows: [string, string | null | undefined][] = [
    ["name", p.name],
    ["access", p.access],
    ["fee", p.fee],
    ["type", p.parkingType],
    ["capacity", p.capacity == null ? null : String(p.capacity)],
    ["maxstay", p.maxstay],
    ["supervised", p.supervised],
    ["opening_hours", p.openingHours],
    ["surface", p.surface],
  ];
  const lines = rows
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<div><strong>${escape(k)}</strong> ${escape(v)}</div>`)
    .join("");
  const title = `Parking (osm ${escape(p.osmType)}/${escape(p.osmId)})`;
  return `<div style="font:13px system-ui;padding:2px 4px;min-width:200px;max-width:280px">
    <div style="font-weight:600;margin-bottom:4px">${title}</div>
    ${lines || '<div style="color:#888">No additional tags</div>'}
  </div>`;
}

function escape(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] ?? c,
  );
}
