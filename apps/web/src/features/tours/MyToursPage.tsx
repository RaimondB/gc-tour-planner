// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ImageOff,
  Link2,
  Link2Off,
  LocateFixed,
  Navigation,
  Pencil,
  Share2,
  Trash2,
} from "lucide-react";
import type { SavedTourSummary } from "@gctp/shared/tours";
import { haversineMeters } from "@gctp/shared/geo";
import {
  deleteTour,
  getTour,
  listTours,
  renameTour,
  shareTour,
  tourPreviewUrl,
  unshareTour,
} from "../../lib/api.js";
import { parkingNavTarget } from "../../lib/maps.js";
import { cacheTourDetail, pruneCachedTours } from "../../lib/tour-cache.js";
import { OfflineBadge } from "../shell/OfflineBadge.js";
import { useOnline } from "../shell/ConnectivityProvider.js";
import { useLocation } from "../location/LocationProvider.js";
import { useTourSession } from "./TourSessionProvider.js";

const TOURS_KEY = ["tours"] as const;

function km(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Compact "X away" for the distance-from-me badge. */
function away(meters: number): string {
  return meters < 950
    ? `${Math.round(meters / 10) * 10} m away`
    : `${(meters / 1000).toFixed(1)} km away`;
}

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** Copy a share URL to the clipboard, falling back to a prompt the user can
 *  copy from manually (clipboard API is unavailable on insecure origins). */
async function copyShareLink(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    window.alert("Share link copied to clipboard.");
  } catch {
    window.prompt("Copy this share link:", url);
  }
}

/**
 * Protected `/tours` route (M6-γ, FR-P2). Lists the caller's saved tours and
 * lets them open one (rehydrates the planner without replanning), rename, or
 * delete. List/mutations are owner-scoped server-side; a cross-tenant id 404s.
 */
export function MyToursPage(): JSX.Element {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const online = useOnline();
  const location = useLocation();
  const { openTour } = useTourSession();
  const [sortMode, setSortMode] = useState<"recent" | "nearest">("recent");
  const toursQuery = useQuery({
    queryKey: TOURS_KEY,
    queryFn: () => listTours(),
  });

  // Distance from the user to each tour's start (client-side; position never
  // leaves the device). null when location is off / no fix yet.
  const here = location.position;
  const distanceTo = (t: SavedTourSummary): number | null =>
    here ? haversineMeters(here, t.startPoint.coordinates) : null;

  // The server returns newest-first; "nearest" re-sorts by distance client-side.
  const sortedTours = useMemo(() => {
    const list = toursQuery.data ?? [];
    if (sortMode !== "nearest" || !here) return list;
    return [...list].sort(
      (a, b) =>
        haversineMeters(here, a.startPoint.coordinates) -
        haversineMeters(here, b.startPoint.coordinates),
    );
  }, [toursQuery.data, sortMode, here]);

  // Warm the offline store: while online, fetch each listed tour's full detail
  // into IndexedDB (and prime its snapshot in the SW cache) so ANY listed tour
  // opens — and renders — offline later, not just ones opened online first
  // (FR-W3). Best-effort; failures are ignored. The ref skips ids already warmed
  // this session. Also prune the store down to the current list so deleted tours
  // don't linger offline.
  const prefetchedRef = useRef<Set<string>>(new Set());
  const tours = toursQuery.data;
  useEffect(() => {
    if (!online || !tours) return;
    void pruneCachedTours(tours.map((t) => t.id));
    for (const tour of tours) {
      if (prefetchedRef.current.has(tour.id)) continue;
      prefetchedRef.current.add(tour.id);
      void getTour(tour.id)
        .then((detail) => cacheTourDetail(detail))
        .catch(() => {});
      if (tour.hasPreview) {
        const img = new Image();
        img.src = tourPreviewUrl(tour.id);
      }
    }
  }, [online, tours]);

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      renameTour(id, name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: TOURS_KEY }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTour(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TOURS_KEY });
      // Drop the deleted loop from the planner-map footprints layer.
      void qc.invalidateQueries({ queryKey: ["tour-footprints"] });
    },
  });

  // Share: mint (idempotent) → copy the absolute link → refresh so the badge
  // appears. The API returns a client-relative path; we build the URL from the
  // current origin so the server never needs to know its public hostname.
  const shareMutation = useMutation({
    mutationFn: (id: string) => shareTour(id),
    onSuccess: async (res) => {
      await copyShareLink(`${window.location.origin}${res.path}`);
      void qc.invalidateQueries({ queryKey: TOURS_KEY });
    },
  });

  const unshareMutation = useMutation({
    mutationFn: (id: string) => unshareTour(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: TOURS_KEY }),
  });

  const onUnshare = (tour: SavedTourSummary) => {
    if (
      window.confirm(
        `Revoke the share link for "${tour.name}"? The old link will stop working.`,
      )
    ) {
      unshareMutation.mutate(tour.id);
    }
  };

  const onOpen = (tour: SavedTourSummary) => {
    // Set the open tour in the shared session (survives the route change — the
    // provider lives above the router), then go to the planner which renders it
    // from the stored plan (no replan, no router-state round-trip). See App.tsx.
    openTour(tour.id);
    void navigate({ to: "/" });
  };

  const onRename = (tour: SavedTourSummary) => {
    const next = window.prompt("Rename tour", tour.name)?.trim();
    if (next && next !== tour.name)
      renameMutation.mutate({ id: tour.id, name: next });
  };

  const onDelete = (tour: SavedTourSummary) => {
    if (window.confirm(`Delete "${tour.name}"? This can't be undone.`)) {
      deleteMutation.mutate(tour.id);
    }
  };

  return (
    <div className="tours-page">
      <header className="tours-page__header">
        <div>
          <h1>My tours</h1>
          <p>Saved closed-loop tours. Open one to re-render it on the map.</p>
        </div>
        <OfflineBadge />
        <Link to="/" className="tours-page__back">
          ← Back to planner
        </Link>
      </header>

      {toursQuery.isPending && <p className="muted">Loading…</p>}
      {toursQuery.isError && (
        <p className="auth-error" role="alert">
          Couldn’t load your tours. Try again.
        </p>
      )}

      {toursQuery.data && toursQuery.data.length === 0 && (
        <div className="tours-empty">
          <p>No saved tours yet.</p>
          <p className="muted">
            Plan a tour, then use “Save tour” to keep it here.
          </p>
        </div>
      )}

      {toursQuery.data && toursQuery.data.length > 0 && (
        <>
          <div className="tours-sort">
            <span className="tours-sort__label">Sort</span>
            <button
              type="button"
              className={`tours-sort__btn${sortMode === "recent" ? " tours-sort__btn--on" : ""}`}
              onClick={() => setSortMode("recent")}
            >
              Recent
            </button>
            <button
              type="button"
              className={`tours-sort__btn${sortMode === "nearest" ? " tours-sort__btn--on" : ""}`}
              onClick={() => {
                if (here) setSortMode("nearest");
                else location.enable();
              }}
              disabled={
                location.status === "denied" ||
                location.status === "unavailable"
              }
              title={
                here
                  ? "Sort by distance from your location"
                  : "Turn on your location to sort by nearest"
              }
            >
              <LocateFixed size={14} aria-hidden="true" /> Nearest
            </button>
          </div>
          <ul className="tours-list">
            {sortedTours.map((tour) => (
              <li key={tour.id} className="tours-list__item">
                {tour.hasPreview ? (
                  <img
                    className="tours-list__thumb"
                    src={tourPreviewUrl(tour.id)}
                    alt=""
                    loading="lazy"
                    onClick={() => onOpen(tour)}
                  />
                ) : (
                  <div
                    className="tours-list__thumb tours-list__thumb--placeholder"
                    onClick={() => onOpen(tour)}
                    title="No map preview captured yet"
                    aria-hidden="true"
                  >
                    <ImageOff size={22} />
                  </div>
                )}
                <div className="tours-list__main">
                  <span className="tours-list__name">{tour.name}</span>
                  <span className="tours-list__meta">
                    {tour.cacheCount} caches · {km(tour.totalMeters)} ·{" "}
                    {minutes(tour.totalSeconds)} · {formatDate(tour.createdAt)}
                    {distanceTo(tour) != null && (
                      <span className="badge badge--distance">
                        <LocateFixed size={11} aria-hidden="true" />{" "}
                        {away(distanceTo(tour)!)}
                      </span>
                    )}
                    {tour.isShared && (
                      <span className="badge badge--shared">shared</span>
                    )}
                  </span>
                </div>
                <div className="tours-list__actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onOpen(tour)}
                  >
                    Open
                  </button>
                  <a
                    className="icon-btn"
                    href={parkingNavTarget(tour.startPoint).href}
                    {...(parkingNavTarget(tour.startPoint).external
                      ? { target: "_blank", rel: "noreferrer" }
                      : {})}
                    aria-label={`Navigate to the start of ${tour.name}`}
                    title="Navigate to the tour start (opens your maps app)"
                  >
                    <Navigation size={18} aria-hidden="true" />
                  </a>
                  {tour.isShared ? (
                    <>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => shareMutation.mutate(tour.id)}
                        disabled={shareMutation.isPending || !online}
                        aria-label={`Copy share link for ${tour.name}`}
                        title={
                          online ? "Copy share link" : "Needs a connection."
                        }
                      >
                        <Link2 size={18} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => onUnshare(tour)}
                        disabled={unshareMutation.isPending || !online}
                        aria-label={`Stop sharing ${tour.name}`}
                        title={online ? "Stop sharing" : "Needs a connection."}
                      >
                        <Link2Off size={18} aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => shareMutation.mutate(tour.id)}
                      disabled={shareMutation.isPending || !online}
                      aria-label={`Share ${tour.name}`}
                      title={
                        online
                          ? "Create a read-only share link"
                          : "Sharing needs a connection."
                      }
                    >
                      <Share2 size={18} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => onRename(tour)}
                    disabled={!online}
                    aria-label={`Rename ${tour.name}`}
                    title={online ? "Rename" : "Renaming needs a connection."}
                  >
                    <Pencil size={18} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    onClick={() => onDelete(tour)}
                    disabled={deleteMutation.isPending || !online}
                    aria-label={`Delete ${tour.name}`}
                    title={online ? "Delete" : "Deleting needs a connection."}
                  >
                    <Trash2 size={18} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
