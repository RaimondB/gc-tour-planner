// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Google Maps "directions to" URL for a GeoJSON point (e.g. the tour parking).
 * `api=1` + `destination=lat,lng` opens Google Maps — or the app on mobile —
 * routing from the user's current location. The URL is also plain-shareable.
 */
export function googleMapsDirUrl(point: {
  coordinates: readonly [number, number];
}): string {
  const [lng, lat] = point.coordinates;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}
