// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, type FormEvent, type JSX, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CACHE_TYPES, type CacheType } from "@gctp/shared/caches";
import { LANDUSE_KINDS, type LanduseKind } from "@gctp/shared/landuse";
import type {
  RouteProfileSettings,
  SaveRouteProfileInput,
} from "@gctp/shared/route-profiles";
import { listLanduseProfiles } from "../../lib/api.js";
import { RatingRangeField } from "../search/RatingRangeField.js";

const MULTI_SUBTYPES = [
  ["all", "All multis"],
  ["field-puzzle", "Field puzzles"],
  ["mini", "1–2 stages"],
  ["full", "3+ stages"],
] as const;

export interface RouteProfileEditorProps {
  initial: SaveRouteProfileInput;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (value: SaveRouteProfileInput) => void;
  onCancel: () => void;
}

/** Full editor for one route profile (FR-T19): every setting, grouped. */
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
  const [s, setS] = useState<RouteProfileSettings>(initial.settings);
  const landuse = useQuery({
    queryKey: ["landuse-profiles"],
    queryFn: listLanduseProfiles,
    staleTime: Infinity,
  });

  const set = <K extends Exclude<keyof RouteProfileSettings, "version">>(
    group: K,
    patch: Partial<RouteProfileSettings[K]>,
  ) => setS((prev) => ({ ...prev, [group]: { ...prev[group], ...patch } }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      name: name.trim(),
      description: description.trim() || null,
      settings: s,
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

      <Group title="Which caches">
        <TypeChecklist
          label="Cache types (none ticked = all)"
          value={s.filters.types}
          onChange={(types) => set("filters", { types })}
        />
        <label className="profile-editor__row">
          <span>Multis</span>
          <select
            value={s.filters.multiSubtype}
            onChange={(e) =>
              set("filters", {
                multiSubtype: e.target
                  .value as RouteProfileSettings["filters"]["multiSubtype"],
              })
            }
          >
            {MULTI_SUBTYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <RatingRangeField
          label="Difficulty"
          value={s.filters.difficulty}
          onChange={(difficulty) => set("filters", { difficulty })}
        />
        <RatingRangeField
          label="Terrain"
          value={s.filters.terrain}
          onChange={(terrain) => set("filters", { terrain })}
        />
        <Check
          label="Hide caches requiring special tools"
          checked={s.filters.hideToolCaches}
          onChange={(hideToolCaches) => set("filters", { hideToolCaches })}
        />
        <Check
          label="Only solved mysteries"
          checked={s.filters.solvedMysteriesOnly}
          onChange={(solvedMysteriesOnly) =>
            set("filters", { solvedMysteriesOnly })
          }
        />
        <Check
          label="Skip caches already in my saved tours"
          checked={s.filters.excludeSavedTourCaches}
          onChange={(excludeSavedTourCaches) =>
            set("filters", { excludeSavedTourCaches })
          }
        />
        <KindChecklist
          label="Only inside landuse (none ticked = anywhere)"
          value={s.filters.contexts}
          onChange={(contexts) => set("filters", { contexts })}
        />
      </Group>

      <Group title="Adventure Labs">
        <Check
          label="Include Adventure Labs"
          checked={s.filters.includeAdventureLabs}
          onChange={(includeAdventureLabs) =>
            set("filters", { includeAdventureLabs })
          }
        />
        <Check
          label="Keep each adventure together (all stages or none)"
          checked={s.adventures.keepTogether}
          onChange={(keepTogether) => set("adventures", { keepTogether })}
        />
        <Check
          label="Let stages mix with other caches"
          checked={s.adventures.interleave}
          onChange={(interleave) => set("adventures", { interleave })}
        />
      </Group>

      <Group title="What makes a walk interesting">
        <label className="profile-editor__row">
          <span>Landuse preference</span>
          <select
            value={s.objective.landuseProfileId ?? ""}
            onChange={(e) =>
              set("objective", { landuseProfileId: e.target.value || null })
            }
          >
            <option value="">(no preference)</option>
            {landuse.data?.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <Weight
          label="Landuse weight"
          value={s.objective.landuseWeight}
          onChange={(landuseWeight) => set("objective", { landuseWeight })}
        />
        <Weight
          label="Variety weight"
          hint="Ad-hoc walks: favour a mix of types and ratings."
          value={s.objective.varietyWeight}
          onChange={(varietyWeight) => set("objective", { varietyWeight })}
        />
        <TypeChecklist
          label="Preferred types (ad-hoc walks)"
          value={s.objective.preferredTypes}
          onChange={(preferredTypes) => set("objective", { preferredTypes })}
        />
        <Weight
          label="Preferred-type weight"
          value={s.objective.preferredWeight}
          onChange={(preferredWeight) => set("objective", { preferredWeight })}
        />
      </Group>

      <Group title="Time">
        <NumberRow
          label="Minutes per cache"
          value={s.time.visitMinutes}
          min={0}
          max={120}
          onChange={(visitMinutes) => set("time", { visitMinutes })}
        />
        <NumberRow
          label="Minutes per Adventure Lab stage"
          value={s.time.alStageVisitMinutes}
          min={0}
          max={60}
          onChange={(alStageVisitMinutes) =>
            set("time", { alStageVisitMinutes })
          }
        />
        <NumberRow
          label="Extra minutes for caches needing tools"
          value={s.time.toolBonusMinutes}
          min={0}
          max={60}
          onChange={(toolBonusMinutes) => set("time", { toolBonusMinutes })}
        />
        <NumberRow
          label="Walking speed (km/h)"
          value={s.time.walkingKmh}
          min={1}
          max={10}
          step={0.5}
          onChange={(walkingKmh) => set("time", { walkingKmh })}
        />
        <NumberRow
          label="Safety buffer before the deadline (min, ad-hoc walks)"
          value={s.time.bufferMinutes}
          min={0}
          max={120}
          onChange={(bufferMinutes) => set("time", { bufferMinutes })}
        />
        <details className="profile-editor__more">
          <summary>Minutes per cache type (ad-hoc walks)</summary>
          {CACHE_TYPES.map((t) => (
            <label key={t} className="profile-editor__row">
              <span>{t}</span>
              <input
                type="number"
                min={0}
                max={240}
                placeholder={String(s.time.visitMinutes)}
                value={s.time.visitMinutesByType[t] ?? ""}
                onChange={(e) => {
                  const next = { ...s.time.visitMinutesByType };
                  if (e.target.value === "") delete next[t];
                  else next[t] = Math.round(Number(e.target.value));
                  set("time", { visitMinutesByType: next });
                }}
              />
            </label>
          ))}
        </details>
      </Group>

      <Group title="Budget">
        <NumberRow
          label="Distance budget (km, cluster planner)"
          value={s.budget.distanceBudgetMeters / 1000}
          min={0.5}
          max={25}
          step={0.5}
          onChange={(km) =>
            set("budget", { distanceBudgetMeters: Math.round(km * 1000) })
          }
        />
        <label className="profile-editor__row">
          <span>Default walk duration (min, blank = ask)</span>
          <input
            type="number"
            min={15}
            max={720}
            step={15}
            value={s.budget.defaultDurationMinutes ?? ""}
            onChange={(e) =>
              set("budget", {
                defaultDurationMinutes:
                  e.target.value === ""
                    ? null
                    : Math.round(Number(e.target.value)),
              })
            }
          />
        </label>
      </Group>

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

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="profile-editor__group">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="profile-editor__check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function NumberRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="profile-editor__row">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n)) {
            onChange(Math.min(max, Math.max(min, n)));
          }
        }}
      />
    </label>
  );
}

function Weight({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="profile-editor__row" title={hint}>
      <span>
        {label}: {value}
      </span>
      <input
        type="range"
        min={0}
        max={5}
        step={0.5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function TypeChecklist({
  label,
  value,
  onChange,
}: {
  label: string;
  value: readonly CacheType[];
  onChange: (v: CacheType[]) => void;
}) {
  return (
    <div className="profile-editor__chips" role="group" aria-label={label}>
      <span>{label}</span>
      {CACHE_TYPES.map((t) => (
        <Check
          key={t}
          label={t}
          checked={value.includes(t)}
          onChange={(on) =>
            onChange(on ? [...value, t] : value.filter((x) => x !== t))
          }
        />
      ))}
    </div>
  );
}

function KindChecklist({
  label,
  value,
  onChange,
}: {
  label: string;
  value: readonly LanduseKind[];
  onChange: (v: LanduseKind[]) => void;
}) {
  return (
    <div className="profile-editor__chips" role="group" aria-label={label}>
      <span>{label}</span>
      {LANDUSE_KINDS.map((k) => (
        <Check
          key={k}
          label={k}
          checked={value.includes(k)}
          onChange={(on) =>
            onChange(on ? [...value, k] : value.filter((x) => x !== k))
          }
        />
      ))}
    </div>
  );
}
