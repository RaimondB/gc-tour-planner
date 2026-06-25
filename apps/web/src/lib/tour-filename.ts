// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PlanResult } from "@gctp/shared/tours";

/**
 * Build a short, human-recognisable GPX filename for a planned tour.
 *
 * Convention: `gctp-[place-]<km>km-<n>c-<MonDD>-<mode>.gpx`
 *  - `place`  the OSM parking facility name (when the parking is a named OSM
 *             feature) — the most recognisable anchor; omitted otherwise.
 *  - `<km>`   loop distance, one decimal trimmed (e.g. `8.3`, `12`).
 *  - `<n>c`   number of caches on the loop.
 *  - `<MonDD>` the date, so same-shaped tours stay distinguishable over time.
 *  - `<mode>` `track` or `route` (the two export flavours must not collide).
 *
 * e.g. `gctp-bospark-8.3km-12c-Jun17-track.gpx`, or with no named parking,
 * `gctp-8.3km-12c-Jun17-route.gpx`. Short enough to read in the saved-file
 * toast, specific enough to tell two tours apart in a Downloads folder.
 */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function tourFilename(
  plan: PlanResult,
  mode: "track" | "route",
  now: Date,
): string {
  const km = (plan.totals.meters / 1000).toFixed(1).replace(/\.0$/, "");
  const caches = plan.orderedCacheIds.length;
  const date = `${MONTHS[now.getMonth()]}${String(now.getDate()).padStart(2, "0")}`;
  const place = placeSlug(plan.parking.osm?.name);

  const parts = [place, `${km}km`, `${caches}c`, date, mode].filter(Boolean);
  return `gctp-${parts.join("-")}.gpx`;
}

/**
 * A human-friendly **default tour name**, pre-filled (editable) into the save
 * prompt. Built from the same recognisable anchors as {@link tourFilename}: the
 * OSM parking place (when the parking is a named OSM feature), the loop
 * distance, and the cache count — e.g. `Bospark — 8.3 km · 12 caches`, or with
 * no named parking, `8.3 km loop · 12 caches`. Stays well under TourName's
 * 120-char cap (the place is bounded).
 */
export function suggestTourName(plan: PlanResult): string {
  const km = (plan.totals.meters / 1000).toFixed(1).replace(/\.0$/, "");
  const n = plan.orderedCacheIds.length;
  const caches = `${n} cache${n === 1 ? "" : "s"}`;
  const place = plan.parking.osm?.name?.trim().slice(0, 60);
  return place
    ? `${place} — ${km} km · ${caches}`
    : `${km} km loop · ${caches}`;
}

/** Lowercase kebab slug of a parking name, capped so the filename stays short. */
function placeSlug(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 24)
    .replace(/-+$/, "");
}
