// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";
import type { BoundingBox } from "@gctp/shared/geo";
import { useMap } from "./MapContext.js";

interface UseViewportBboxOpts {
  /** Skip the fetch entirely below this zoom. Returns null. */
  minZoom?: number;
  /**
   * Quantise the bbox to a fixed lat/lng grid + pad by one cell. Small
   * pans inside a cell don't change the result, so React Query sees the
   * same key and skips the refetch. 0 disables snapping.
   */
  gridDeg?: number;
  /** moveend debounce in ms. Cheap default for an active pan/zoom session. */
  debounceMs?: number;
}

const DEFAULTS = {
  minZoom: 0,
  gridDeg: 0,
  debounceMs: 250,
} as const;

/**
 * Track the current map viewport as a `BoundingBox`. Updates on
 * `moveend`, debounced, optionally snapped to a grid so small pans
 * inside a tile don't trigger refetches.
 *
 * Layers should use this instead of the static search-radius bbox when
 * they want to follow the user's actual view + benefit from
 * server-side LOD scaling (smaller bbox → finer detail).
 *
 * Returns `null` below `minZoom` (or before the map is ready) — callers
 * gate their useQuery on that.
 */
export function useViewportBbox(
  opts: UseViewportBboxOpts = {},
): BoundingBox | null {
  const { minZoom, gridDeg, debounceMs } = { ...DEFAULTS, ...opts };
  const { map, ready } = useMap();
  const [bbox, setBbox] = useState<BoundingBox | null>(null);

  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (map.getZoom() < minZoom) {
        setBbox(null);
        return;
      }
      const b = map.getBounds();
      const raw: BoundingBox = {
        minLng: b.getWest(),
        minLat: b.getSouth(),
        maxLng: b.getEast(),
        maxLat: b.getNorth(),
      };
      const snapped = gridDeg > 0 ? snapBbox(raw, gridDeg) : raw;
      setBbox((prev) => (prev && bboxEquals(prev, snapped) ? prev : snapped));
    };
    const onMove = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(update, debounceMs);
    };
    update(); // initial snapshot
    map.on("moveend", onMove);
    return () => {
      map.off("moveend", onMove);
      if (timer) clearTimeout(timer);
    };
  }, [map, ready, minZoom, gridDeg, debounceMs]);

  return bbox;
}

function snapBbox(b: BoundingBox, grid: number): BoundingBox {
  return {
    minLng: Math.floor(b.minLng / grid) * grid - grid,
    minLat: Math.floor(b.minLat / grid) * grid - grid,
    maxLng: Math.ceil(b.maxLng / grid) * grid + grid,
    maxLat: Math.ceil(b.maxLat / grid) * grid + grid,
  };
}

function bboxEquals(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.minLng === b.minLng &&
    a.minLat === b.minLat &&
    a.maxLng === b.maxLng &&
    a.maxLat === b.maxLat
  );
}

/**
 * Convert a bbox to an approximate (center, radius) pair — used by the
 * walking-graph endpoint which still takes the legacy radius-style
 * input. Radius is the half-diagonal of the bbox in meters, computed
 * via the local cos(lat) factor so a viewport away from the equator
 * still gets a sensible value.
 */
export function bboxToCenterRadius(b: BoundingBox): {
  center: [number, number];
  radiusM: number;
} {
  const centerLng = (b.minLng + b.maxLng) / 2;
  const centerLat = (b.minLat + b.maxLat) / 2;
  const dLat = b.maxLat - b.minLat;
  const dLng = b.maxLng - b.minLng;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const halfDiagonalM =
    Math.sqrt((dLat * mPerDegLat) ** 2 + (dLng * mPerDegLng) ** 2) / 2;
  return {
    center: [centerLng, centerLat],
    radiusM: Math.max(1, Math.round(halfDiagonalM)),
  };
}
