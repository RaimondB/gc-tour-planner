// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, type JSX } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import type { SavedTourSummary } from "@gctp/shared/tours";
import {
  deleteTour,
  getTour,
  listTours,
  renameTour,
  tourPreviewUrl,
} from "../../lib/api.js";
import { cacheTourDetail, pruneCachedTours } from "../../lib/tour-cache.js";
import { OfflineBadge } from "../shell/OfflineBadge.js";
import { useOnline } from "../shell/ConnectivityProvider.js";
import { useTourSession } from "./TourSessionProvider.js";

const TOURS_KEY = ["tours"] as const;

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

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
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
  const { openTour } = useTourSession();
  const toursQuery = useQuery({
    queryKey: TOURS_KEY,
    queryFn: () => listTours(),
  });

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
    onSuccess: () => void qc.invalidateQueries({ queryKey: TOURS_KEY }),
  });

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
        <ul className="tours-list">
          {toursQuery.data.map((tour) => (
            <li key={tour.id} className="tours-list__item">
              {tour.hasPreview && (
                <img
                  className="tours-list__thumb"
                  src={tourPreviewUrl(tour.id)}
                  alt=""
                  loading="lazy"
                  onClick={() => onOpen(tour)}
                />
              )}
              <div className="tours-list__main">
                <span className="tours-list__name">{tour.name}</span>
                <span className="tours-list__meta">
                  {tour.cacheCount} caches · {km(tour.totalMeters)} ·{" "}
                  {minutes(tour.totalSeconds)} · {formatDate(tour.createdAt)}
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
      )}
    </div>
  );
}
