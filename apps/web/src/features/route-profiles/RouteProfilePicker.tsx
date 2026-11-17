// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, type FormEvent, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RouteProfile } from "@gctp/shared/route-profiles";
import {
  createRouteProfile,
  listRouteProfiles,
  updateRouteProfile,
} from "../../lib/api.js";
import { useOnline } from "../shell/ConnectivityProvider.js";
import {
  applyRouteProfile,
  plannerDiffersFromProfile,
  profileFromPlanner,
  type PlannerState,
} from "./profile-mapping.js";
import {
  ROUTE_PROFILES_KEY,
  saveErrorMessage,
} from "./RouteProfilesSection.js";

export interface RouteProfilePickerProps {
  state: PlannerState;
  onApply: (next: PlannerState) => void;
  activeId: string | null;
  onActiveIdChange: (id: string | null) => void;
}

/**
 * Planner-side profile control (FR-T19): pick a profile to fill the filters and
 * plan settings, see when they've been changed since, and save the current
 * settings as a new profile (or back into your own). Never writes back on its
 * own.
 */
export function RouteProfilePicker({
  state,
  onApply,
  activeId,
  onActiveIdChange,
}: RouteProfilePickerProps): JSX.Element {
  const online = useOnline();
  const queryClient = useQueryClient();
  const profiles = useQuery({
    queryKey: ROUTE_PROFILES_KEY,
    queryFn: listRouteProfiles,
    staleTime: 5 * 60_000,
  });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const active = profiles.data?.find((p) => p.id === activeId) ?? null;
  const modified = active
    ? plannerDiffersFromProfile(active.settings, state)
    : false;

  const saved = async (p: RouteProfile) => {
    setError(null);
    setNaming(false);
    setName("");
    onActiveIdChange(p.id);
    await queryClient.invalidateQueries({ queryKey: ROUTE_PROFILES_KEY });
  };
  const create = useMutation({
    mutationFn: (newName: string) =>
      createRouteProfile({
        name: newName,
        description: null,
        settings: profileFromPlanner(state),
      }),
    onSuccess: saved,
    onError: (err) => setError(saveErrorMessage(err)),
  });
  const update = useMutation({
    mutationFn: (p: RouteProfile) =>
      updateRouteProfile(p.id, {
        name: p.name,
        description: p.description,
        settings: profileFromPlanner(state),
      }),
    onSuccess: saved,
    onError: (err) => setError(saveErrorMessage(err)),
  });

  const select = (id: string) => {
    const p = profiles.data?.find((x) => x.id === id);
    if (!p) {
      onActiveIdChange(null);
      return;
    }
    onApply(applyRouteProfile(p.settings, state));
    onActiveIdChange(p.id);
  };
  const submitName = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  };

  return (
    <div className="profile-picker">
      <label className="profile-picker__row">
        <span>Profile</span>
        <select
          value={active?.id ?? ""}
          disabled={!profiles.data}
          onChange={(e) => select(e.target.value)}
        >
          <option value="">(none — custom settings)</option>
          {profiles.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {modified && (
        <span className="profile-picker__modified">
          Changed since choosing “{active?.name}”{" · "}
          <button
            type="button"
            className="link-button"
            onClick={() => active && select(active.id)}
          >
            Reset
          </button>
        </span>
      )}
      {naming ? (
        <form className="profile-picker__row" onSubmit={submitName}>
          <input
            autoFocus
            placeholder="Profile name"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="submit"
            className="link-button"
            disabled={!online || create.isPending || !name.trim()}
          >
            Save
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => setNaming(false)}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="profile-picker__row">
          <button
            type="button"
            className="link-button"
            disabled={!online}
            onClick={() => setNaming(true)}
          >
            Save as new profile…
          </button>
          {active && active.ownerId !== null && modified && (
            <button
              type="button"
              className="link-button"
              disabled={!online || update.isPending}
              onClick={() => update.mutate(active)}
            >
              Update “{active.name}”
            </button>
          )}
          <Link to="/account" className="link-button">
            Manage
          </Link>
        </div>
      )}
      {error && (
        <small className="auth-field__error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
