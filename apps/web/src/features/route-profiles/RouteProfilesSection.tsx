// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RouteProfileSettings,
  type RouteProfile,
  type SaveRouteProfileInput,
} from "@gctp/shared/route-profiles";
import {
  ApiError,
  createRouteProfile,
  deleteRouteProfile,
  listRouteProfiles,
  updateRouteProfile,
} from "../../lib/api.js";
import { useOnline } from "../shell/ConnectivityProvider.js";
import { RouteProfileEditor } from "./RouteProfileEditor.js";

export const ROUTE_PROFILES_KEY = ["route-profiles"] as const;

type Editing =
  | { mode: "create"; initial: SaveRouteProfileInput }
  | { mode: "edit"; id: string; initial: SaveRouteProfileInput };

export function saveErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    return "You already have a profile with this name.";
  }
  return "Couldn't save the profile — check the values and your connection.";
}

/** Account-page section: list, create, edit, duplicate, delete (FR-T19). */
export function RouteProfilesSection(): JSX.Element {
  const online = useOnline();
  const queryClient = useQueryClient();
  const profiles = useQuery({
    queryKey: ROUTE_PROFILES_KEY,
    queryFn: listRouteProfiles,
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ROUTE_PROFILES_KEY });

  const save = useMutation({
    mutationFn: (value: SaveRouteProfileInput) =>
      editing?.mode === "edit"
        ? updateRouteProfile(editing.id, value)
        : createRouteProfile(value),
    onSuccess: async () => {
      setEditing(null);
      setError(null);
      await refresh();
    },
    onError: (err) => setError(saveErrorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: deleteRouteProfile,
    onSuccess: refresh,
  });

  const start = (next: Editing) => {
    setError(null);
    setEditing(next);
  };
  const copyOf = (p: RouteProfile): SaveRouteProfileInput => ({
    name: `${p.name} (copy)`,
    description: p.description,
    settings: p.settings,
  });

  return (
    <section className="auth-card route-profiles">
      <h2 className="auth-card__title">Route profiles</h2>
      <p className="auth-card__subtitle">
        Saved planning presets: which caches, what makes a walk interesting,
        time per cache and budgets. Pick one in the planner instead of setting
        everything by hand. Built-in profiles can be copied, not changed.
      </p>

      {profiles.isLoading && <p className="muted">Loading…</p>}
      {profiles.isError && (
        <p className="auth-error" role="alert">
          Couldn&rsquo;t load your profiles.
        </p>
      )}

      <ul className="route-profiles__list">
        {profiles.data?.map((p) => (
          <li key={p.id} className="route-profiles__item">
            <div>
              <strong>{p.name}</strong>
              {p.ownerId === null && (
                <span className="route-profiles__badge">built-in</span>
              )}
              {p.description && (
                <small className="route-profiles__desc">{p.description}</small>
              )}
            </div>
            <div className="route-profiles__actions">
              {p.ownerId !== null && (
                <button
                  type="button"
                  className="link-button"
                  disabled={!online}
                  onClick={() =>
                    start({
                      mode: "edit",
                      id: p.id,
                      initial: {
                        name: p.name,
                        description: p.description,
                        settings: p.settings,
                      },
                    })
                  }
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                className="link-button"
                disabled={!online}
                onClick={() => start({ mode: "create", initial: copyOf(p) })}
              >
                Copy
              </button>
              {p.ownerId !== null && (
                <button
                  type="button"
                  className="link-button link-button--danger"
                  disabled={!online || remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Delete the profile “${p.name}”?`)) {
                      remove.mutate(p.id);
                    }
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {editing ? (
        <RouteProfileEditor
          key={editing.mode === "edit" ? editing.id : editing.initial.name}
          initial={editing.initial}
          submitLabel={editing.mode === "edit" ? "Save changes" : "Create"}
          pending={save.isPending}
          error={error}
          onSubmit={(value) => save.mutate(value)}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button
          type="button"
          className="auth-submit"
          disabled={!online}
          title={online ? undefined : "Editing profiles needs a connection."}
          onClick={() =>
            start({
              mode: "create",
              initial: {
                name: "",
                description: null,
                settings: RouteProfileSettings.parse({}),
              },
            })
          }
        >
          New profile
        </button>
      )}
    </section>
  );
}
