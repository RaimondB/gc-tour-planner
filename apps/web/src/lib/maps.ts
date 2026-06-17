// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

type GeoPoint = { coordinates: readonly [number, number] };

/**
 * Google Maps "directions to" URL for a GeoJSON point (e.g. the tour parking).
 * `api=1` + `destination=lat,lng` opens Google Maps in the browser. This is the
 * desktop / shareable form — but it is a *web* URL: offline it cannot load, and
 * from an installed PWA it does not reliably hand off to a maps app. For the tap
 * action use {@link parkingNavTarget}, which emits a native OS map-intent URI.
 */
export function googleMapsDirUrl(point: GeoPoint): string {
  const [lng, lat] = point.coordinates;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

type Platform = "android" | "ios" | "desktop";

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "android";
  // iPhone/iPod/iPad — plus iPadOS 13+, which reports as desktop Safari
  // ("Macintosh") but is a touch device.
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return "ios";
  return "desktop";
}

/**
 * Where the "Navigate to parking" link should point, per platform.
 *
 * Native map-intent URIs are resolved by the OS *without network*, so they work
 * offline and route straight to the installed maps app (where downloaded offline
 * maps take over):
 *   - Android → `google.navigation:` — direct turn-by-turn in Google Maps.
 *   - iOS     → `maps://` — Apple Maps directions (always installed, offline-capable).
 *   - desktop → the shareable Google Maps web URL.
 *
 * `external` is true only for the http(s) desktop URL. Custom app schemes must
 * NOT use `target="_blank"` — it opens a blank tab that never closes.
 */
export function parkingNavTarget(point: GeoPoint): {
  href: string;
  external: boolean;
} {
  const [lng, lat] = point.coordinates;
  switch (detectPlatform()) {
    case "android":
      return { href: `google.navigation:q=${lat},${lng}`, external: false };
    case "ios":
      return { href: `maps://?daddr=${lat},${lng}&dirflg=d`, external: false };
    default:
      return { href: googleMapsDirUrl(point), external: true };
  }
}
