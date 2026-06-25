// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo, type JSX } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { PlanResult, SharedTour } from "@gctp/shared/tours";
import { type ApiError, getSharedTour } from "../../lib/api.js";
import { MapView } from "../map/MapView.js";
import { TourLayer } from "../map/TourLayer.js";
import { useMap } from "../map/MapContext.js";
import { tourCachesToSummaries } from "./saved-tour-view.js";

function km(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
}

/** Bounding box [[minLng,minLat],[maxLng,maxLat]] of the routed polyline. */
function polylineBounds(
  coords: readonly [number, number][],
): [[number, number], [number, number]] | null {
  if (coords.length === 0) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

/** Frame the map to the tour once the style is live. */
function FitToTour({
  bounds,
}: {
  bounds: [[number, number], [number, number]] | null;
}): null {
  const { map, ready } = useMap();
  useEffect(() => {
    if (!ready || !map || !bounds) return;
    map.fitBounds(bounds, { padding: 56, duration: 0, maxZoom: 16 });
  }, [map, ready, bounds]);
  return null;
}

/**
 * Adapt the public {@link SharedTour} payload into the `PlanResult` shape
 * {@link TourLayer} consumes. The shared payload carries no per-leg breakdown,
 * dropped caches, or score — only geometry, totals, parking, and the cache
 * snapshot — so those collapse to empty/neutral values. Parking falls back to
 * the loop's first vertex when the original used a centroid (so a start marker
 * still renders) without claiming it was a real parking spot.
 */
function toPlanLike(shared: SharedTour): PlanResult {
  const startPoint: PlanResult["parking"]["point"] = shared.parking ?? {
    type: "Point",
    coordinates: shared.polyline.coordinates[0] ?? [0, 0],
  };
  return {
    orderedCacheIds: shared.caches.map((c) => c.id),
    droppedCacheIds: [],
    droppedCaches: [],
    polyline: shared.polyline,
    totals: shared.totals,
    parking: {
      type: "osrm-nearest",
      point: startPoint,
      reason: "",
      fallback: shared.parking == null,
    },
    scoreBreakdown: {},
    legs: [],
  };
}

/**
 * Public, anonymous read-only view of a shared tour (FR-P3.2, ADR-0022). No app
 * shell, no auth, no edit/share controls — just the route, its numbered stops,
 * and the cache list, rendered purely from the `/shared/:slug` snapshot. The map
 * carries the required OSM attribution. A revoked/unknown slug shows a friendly
 * dead-end with a link to plan your own.
 */
export function SharedTourPage(): JSX.Element {
  const { slug } = useParams({ from: "/shared/$slug" });
  const query = useQuery({
    queryKey: ["shared", slug],
    queryFn: () => getSharedTour(slug),
    retry: false,
  });

  const shared = query.data;
  const planLike = useMemo(
    () => (shared ? toPlanLike(shared) : null),
    [shared],
  );
  const summaries = useMemo(
    () => (shared ? tourCachesToSummaries(shared.caches) : []),
    [shared],
  );
  const bounds = useMemo(
    () =>
      shared
        ? polylineBounds(shared.polyline.coordinates as [number, number][])
        : null,
    [shared],
  );
  const center = useMemo<[number, number] | undefined>(() => {
    if (!bounds) return undefined;
    return [
      (bounds[0][0] + bounds[1][0]) / 2,
      (bounds[0][1] + bounds[1][1]) / 2,
    ];
  }, [bounds]);

  const gone = query.isError && (query.error as ApiError)?.status === 404;

  return (
    <div className="shared-tour">
      <header className="shared-tour__header">
        <div className="shared-tour__title">
          <h1>{shared?.name ?? "Shared tour"}</h1>
          {shared && (
            <p className="shared-tour__meta">
              {shared.caches.length} caches · {km(shared.totals.meters)} ·{" "}
              {minutes(shared.totals.seconds)} walking
            </p>
          )}
        </div>
        <Link to="/welcome" className="shared-tour__cta">
          Plan your own →
        </Link>
      </header>

      {query.isPending && <p className="muted shared-tour__status">Loading…</p>}

      {query.isError && (
        <div className="shared-tour__status" role="alert">
          {gone ? (
            <>
              <p>This shared tour is no longer available.</p>
              <p className="muted">
                The link may have been revoked by its owner.
              </p>
            </>
          ) : (
            <p>Couldn’t load this shared tour. Try again later.</p>
          )}
        </div>
      )}

      {shared && planLike && (
        <div className="shared-tour__body">
          <div className="shared-tour__map">
            <MapView initialCenter={center} initialZoom={13}>
              <TourLayer result={planLike} caches={summaries} />
              <FitToTour bounds={bounds} />
            </MapView>
          </div>
          <ol className="shared-tour__list">
            {shared.caches.map((c, i) => (
              <li key={c.id} className="shared-tour__stop">
                <span className="shared-tour__stop-n">{i + 1}</span>
                <span className="shared-tour__stop-code">{c.code}</span>
                <span className="shared-tour__stop-name">{c.name}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
