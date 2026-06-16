// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type maplibregl from "maplibre-gl";

interface IdleOpts {
  /**
   * When true, always wait for the NEXT `idle` event (capped by `timeoutMs`).
   * Use after kicking off a camera move (e.g. fitBounds on open) so the
   * snapshot reflects the settled view, not the frame before the move.
   */
  awaitNextIdle?: boolean;
  timeoutMs?: number;
}

/** Resolve once the map has settled (tiles + layers loaded, no animation). */
function waitUntilIdle(
  map: maplibregl.Map,
  { awaitNextIdle = false, timeoutMs = 4000 }: IdleOpts,
): Promise<void> {
  if (
    !awaitNextIdle &&
    map.loaded() &&
    map.areTilesLoaded() &&
    !map.isMoving()
  ) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      map.off("idle", finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    map.on("idle", finish);
  });
}

/**
 * Capture a WebP snapshot of the current map (basemap + drawn overlays) for a
 * saved tour's offline preview / list thumbnail (FR-W4). Returns null — never
 * throws — when capture isn't possible, so callers treat it as best-effort:
 *
 *  - `toBlob` throws `SecurityError` if the WebGL canvas is tainted by a tile
 *    source that didn't send CORS headers (the prod style host must, or the
 *    snapshot is simply skipped and the tour still saves).
 *  - requires `preserveDrawingBuffer: true` on the map (set in MapView).
 */
export async function captureMapSnapshot(
  map: maplibregl.Map,
  opts: IdleOpts = {},
): Promise<Blob | null> {
  try {
    await waitUntilIdle(map, opts);
    return await new Promise<Blob | null>((resolve) => {
      try {
        map.getCanvas().toBlob((blob) => resolve(blob), "image/webp", 0.72);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}
