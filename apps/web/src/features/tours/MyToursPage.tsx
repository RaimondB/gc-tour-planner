// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { type JSX } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SavedTourSummary } from "@gctp/shared/tours";
import { deleteTour, listTours, renameTour } from "../../lib/api.js";

const TOURS_KEY = ["tours"] as const;

/** Inline stroke icons (no icon font — matches AttributeIcon/Logo). */
function PencilIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

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
  const toursQuery = useQuery({
    queryKey: TOURS_KEY,
    queryFn: () => listTours(),
  });

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
    // Hand the id to the app shell via router state; App fetches the full tour
    // and re-renders the loop from the stored plan (no replan). See App.tsx.
    void navigate({ to: "/", state: { openTourId: tour.id } });
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
                  aria-label={`Rename ${tour.name}`}
                  title="Rename"
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  onClick={() => onDelete(tour)}
                  disabled={deleteMutation.isPending}
                  aria-label={`Delete ${tour.name}`}
                  title="Delete"
                >
                  <TrashIcon />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
