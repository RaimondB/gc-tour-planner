// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Geo } from "@gctp/shared";

/**
 * 0.1° cells (~11 km × 7 km at lat 52°). Small enough that Overpass returns
 * fast (a few seconds for densely-mapped areas) and big enough that one cell
 * usually covers a typical search radius.
 */
export const CELL_SIZE_DEG = 0.1;

/** Stale after 30 days — see docs/design/osm-overpass.md. */
export const STALENESS_MS = 30 * 24 * 60 * 60 * 1000;

export interface Cell {
  /** Snapped lower-left corner. */
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  /** Stable identifier for the cell. */
  areaHash: string;
}

function floorToCell(v: number): number {
  return Math.floor(v / CELL_SIZE_DEG) * CELL_SIZE_DEG;
}

export function cellFor(lng: number, lat: number): Cell {
  const minLng = roundDeg(floorToCell(lng));
  const minLat = roundDeg(floorToCell(lat));
  return {
    minLng,
    minLat,
    maxLng: roundDeg(minLng + CELL_SIZE_DEG),
    maxLat: roundDeg(minLat + CELL_SIZE_DEG),
    areaHash: `${minLng.toFixed(2)},${minLat.toFixed(2)}`,
  };
}

/** Enumerate every cell that overlaps `bbox`. */
export function cellsCovering(bbox: Geo.BoundingBox): Cell[] {
  const cells: Cell[] = [];
  for (
    let lat = floorToCell(bbox.minLat);
    lat < bbox.maxLat;
    lat = roundDeg(lat + CELL_SIZE_DEG)
  ) {
    for (
      let lng = floorToCell(bbox.minLng);
      lng < bbox.maxLng;
      lng = roundDeg(lng + CELL_SIZE_DEG)
    ) {
      cells.push(cellFor(lng, lat));
    }
  }
  return cells;
}

/** Avoid FP drift like 5.100000000000001. */
function roundDeg(n: number): number {
  return Math.round(n * 100) / 100;
}
