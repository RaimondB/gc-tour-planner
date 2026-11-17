// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, type FormEvent, type JSX } from "react";
import type {
  RouteProfileSettings,
  SaveRouteProfileInput,
} from "@gctp/shared/route-profiles";
import { AllSettingsSections } from "../settings/SettingsSections.js";

export interface RouteProfileEditorProps {
  initial: SaveRouteProfileInput;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (value: SaveRouteProfileInput) => void;
  onCancel: () => void;
}

/**
 * Profile editor (FR-T19): name + description over the same settings form the
 * planner uses, so a profile can hold exactly what the planner can set.
 */
export function RouteProfileEditor({
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: RouteProfileEditorProps): JSX.Element {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [settings, setSettings] = useState<RouteProfileSettings>(
    initial.settings,
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      name: name.trim(),
      description: description.trim() || null,
      settings,
    });
  };

  return (
    <form className="profile-editor" onSubmit={submit} noValidate>
      <label className="auth-field">
        <span>Name</span>
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label className="auth-field">
        <span>Description</span>
        <input
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <div className="sidebar profile-editor__settings">
        <AllSettingsSections value={settings} onChange={setSettings} />
      </div>

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <div className="profile-editor__actions">
        <button
          type="submit"
          className="auth-submit"
          disabled={pending || name.trim() === ""}
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
