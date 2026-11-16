// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { JSX, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CACHE_TYPES, type CacheType } from "@gctp/shared/caches";
import { LANDUSE_KINDS, type LanduseKind } from "@gctp/shared/landuse";
import {
  PARKING_ACCESS_CHIPS,
  PARKING_FEE_FILTER,
} from "@gctp/shared/parking-facilities";
import type { RouteProfileSettings } from "@gctp/shared/route-profiles";
import type {
  ClusteringStrategyName,
  StartPreference,
} from "@gctp/shared/tours";
import { listLanduseProfiles } from "../../lib/api.js";
import { AdvancedSection } from "../shell/AdvancedSection.js";
import { RatingRangeField } from "../search/RatingRangeField.js";

/**
 * The planning settings form (ADR-0039): one set of sections over the
 * profile-shaped settings value, used by the planner's steps and by the
 * Account-page profile editor alike, so both always offer the same settings.
 * Render inside an element with the `sidebar` class for the shared styling.
 */

export interface SectionProps {
  value: RouteProfileSettings;
  onChange: (next: RouteProfileSettings) => void;
}

type Group = Exclude<keyof RouteProfileSettings, "version">;

function useGroup<K extends Group>(
  { value, onChange }: SectionProps,
  group: K,
): [
  RouteProfileSettings[K],
  (patch: Partial<RouteProfileSettings[K]>) => void,
] {
  return [
    value[group],
    (patch) => onChange({ ...value, [group]: { ...value[group], ...patch } }),
  ];
}

export function SearchAreaSection(props: SectionProps): JSX.Element {
  const [search, set] = useGroup(props, "search");
  return (
    <div className="field">
      <label>
        Radius (m): {search.radiusM.toLocaleString("en-US")}
        <input
          type="range"
          min={500}
          max={50_000}
          step={500}
          value={search.radiusM}
          onChange={(e) => set({ radiusM: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}

const MULTI_SUBTYPES = [
  ["all", "All"],
  ["field-puzzle", "Field-puzzle (stages unknown)"],
  ["mini", "Mini-multi (1–2 stages)"],
  ["full", "Full multi (3+ stages)"],
] as const;

export interface CacheFiltersSectionProps extends SectionProps {
  /** Planner-only controls shown at the top of the landuse fieldset. */
  landuseExtras?: ReactNode;
}

export function CacheFiltersSection({
  landuseExtras,
  ...props
}: CacheFiltersSectionProps): JSX.Element {
  const [f, set] = useGroup(props, "filters");
  return (
    <>
      <fieldset className="field">
        <legend>Cache types</legend>
        <TypeChecks
          name="filter-type"
          value={f.types}
          onChange={(types) => set({ types })}
        />
        <small>No selection = any type</small>
        {f.types.includes("Multi") && (
          <div className="filter-sub" style={{ marginTop: 6 }}>
            <small style={{ display: "block", marginBottom: 2 }}>
              Multi sub-type
            </small>
            {MULTI_SUBTYPES.map(([val, label]) => (
              <label key={val} className="checkbox">
                <input
                  type="radio"
                  name="multi-subtype"
                  checked={f.multiSubtype === val}
                  onChange={() => set({ multiSubtype: val })}
                />
                {label}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="field">
        <legend>My finds</legend>
        <Check
          label="Exclude caches I have found"
          checked={f.excludeFound}
          onChange={(excludeFound) => set({ excludeFound })}
        />
        <small>
          Upload a Groundspeak &ldquo;My Finds&rdquo; GPX (detected
          automatically), or mark caches one-by-one from the map popup.
        </small>
      </fieldset>

      <AdvancedSection title="More filters">
        <fieldset className="field">
          <legend>Difficulty &amp; terrain</legend>
          <RatingRangeField
            label="Difficulty"
            value={f.difficulty}
            onChange={(difficulty) => set({ difficulty })}
          />
          <RatingRangeField
            label="Terrain"
            value={f.terrain}
            onChange={(terrain) => set({ terrain })}
          />
          <small>
            Caches without a rating (such as Adventure Lab stages) are always
            shown.
          </small>
        </fieldset>

        <fieldset className="field">
          <legend>Availability</legend>
          <Check
            label="Include temporarily-disabled caches"
            checked={f.includeDisabled}
            onChange={(includeDisabled) => set({ includeDisabled })}
          />
          <small>
            Disabled caches are temporarily out of service (owner maintenance).
            Hidden by default; when shown they render at 50 % opacity with a
            &ldquo;Z&rdquo; overlay. Archived caches are always hidden.
          </small>
        </fieldset>

        <fieldset className="field">
          <legend>Mysteries</legend>
          <Check
            label="Only show solved mysteries"
            checked={f.solvedMysteriesOnly}
            onChange={(solvedMysteriesOnly) => set({ solvedMysteriesOnly })}
          />
          <small>
            Hides Mystery caches you haven&rsquo;t solved (other types are
            unaffected). To populate solved coordinates, upload a Groundspeak
            GPX of your solved mysteries and tick &ldquo;contains solved
            coordinates&rdquo; on upload.
          </small>
        </fieldset>

        <fieldset className="field">
          <legend>Equipment</legend>
          <Check
            label="Hide caches requiring special tools"
            checked={f.hideToolCaches}
            onChange={(hideToolCaches) => set({ hideToolCaches })}
          />
          <small>
            Excludes caches with attributes like climbing gear, boat, scuba,
            flashlight, snowshoes, or &ldquo;special tool required&rdquo; (e.g.
            angler pole). Also catches caches whose description mentions a tool
            (fishing rod, ladder, mirror, &hellip;) in en/nl/de.
          </small>
        </fieldset>

        <fieldset className="field">
          <legend>Saved tours</legend>
          <Check
            label="Skip caches already in my tours"
            checked={f.excludeSavedTourCaches}
            onChange={(excludeSavedTourCaches) =>
              set({ excludeSavedTourCaches })
            }
          />
          <small>
            On, cluster discovery surfaces new areas. Off re-discovers clusters
            over caches that belong to your saved tours.
          </small>
        </fieldset>

        <fieldset className="field">
          <legend>Landuse context</legend>
          {landuseExtras}
          {LANDUSE_KINDS.map((k) => (
            <label key={k} className="checkbox">
              <input
                type="checkbox"
                checked={f.contexts.includes(k)}
                onChange={() =>
                  set({
                    contexts: f.contexts.includes(k)
                      ? f.contexts.filter((c) => c !== k)
                      : [...f.contexts, k],
                  })
                }
              />
              {labelForKind(k)}
            </label>
          ))}
          <small>
            Tick one or more to only keep caches inside those areas (from
            OpenStreetMap). None ticked = anywhere.
          </small>
        </fieldset>
      </AdvancedSection>
    </>
  );
}

export function BudgetSection(props: SectionProps): JSX.Element {
  const [b, set] = useGroup(props, "budget");
  const limited = b.durationMinutes !== null;
  return (
    <div className="field">
      <label>
        Tour length budget: {b.distanceBudgetMeters.toLocaleString("en-US")} m
        <input
          type="range"
          min={1_000}
          max={25_000}
          step={500}
          value={b.distanceBudgetMeters}
          onChange={(e) =>
            set({ distanceBudgetMeters: Number(e.target.value) })
          }
        />
        <small className="muted">
          Roughly how far you want to walk in one loop.
        </small>
      </label>
      <Check
        label="Limit the time I have"
        checked={limited}
        onChange={(on) => set({ durationMinutes: on ? 180 : null })}
      />
      {limited && (
        <>
          <label>
            Time available: {formatDuration(b.durationMinutes!)}
            <input
              type="range"
              min={15}
              max={720}
              step={15}
              value={b.durationMinutes!}
              onChange={(e) => set({ durationMinutes: Number(e.target.value) })}
            />
          </label>
          <label>
            Safety buffer: {b.bufferMinutes} min
            <input
              type="range"
              min={0}
              max={120}
              step={5}
              value={b.bufferMinutes}
              onChange={(e) => set({ bufferMinutes: Number(e.target.value) })}
            />
            <small className="muted">
              Plans keep walking (at your walking speed) plus time at the caches
              within the time available minus this buffer.
            </small>
          </label>
        </>
      )}
    </div>
  );
}

export function InterestSection(props: SectionProps): JSX.Element {
  const [o, set] = useGroup(props, "objective");
  const landuseProfiles = useQuery({
    queryKey: ["landuse-profiles"],
    queryFn: listLanduseProfiles,
    staleTime: 5 * 60_000,
  });
  const profiles = landuseProfiles.data?.profiles ?? [];
  const chosen = profiles.find((p) => p.id === o.landuseProfileId);
  return (
    <fieldset className="field">
      <legend>What makes it interesting</legend>
      <label className="select">
        Landuse preference
        <select
          value={o.landuseProfileId ?? ""}
          onChange={(e) => set({ landuseProfileId: e.target.value || null })}
        >
          <option value="">(no preference)</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.ownerId === null ? "" : " (mine)"}
            </option>
          ))}
        </select>
      </label>
      {chosen?.description && (
        <p className="muted" style={{ marginTop: 4 }}>
          {chosen.description}
        </p>
      )}
      <Weight
        label="Landuse weight"
        value={o.landuseWeight}
        onChange={(landuseWeight) => set({ landuseWeight })}
      />
      <Weight
        label="Prefer central clusters"
        value={o.centerProximityWeight}
        onChange={(centerProximityWeight) => set({ centerProximityWeight })}
      />
      <Weight
        label="Variety of types & difficulty"
        value={o.varietyWeight}
        onChange={(varietyWeight) => set({ varietyWeight })}
      />
      <div className="settings-types">
        <small>Preferred cache types</small>
        <TypeChecks
          name="preferred-type"
          value={o.preferredTypes}
          onChange={(preferredTypes) => set({ preferredTypes })}
        />
      </div>
      {o.preferredTypes.length > 0 && (
        <Weight
          label="Preferred-type weight"
          value={o.preferredWeight}
          onChange={(preferredWeight) => set({ preferredWeight })}
        />
      )}
    </fieldset>
  );
}

export function AdventureLabsSection(props: SectionProps): JSX.Element {
  const [a, set] = useGroup(props, "adventures");
  return (
    <fieldset className="field">
      <legend>Adventure Labs</legend>
      <Check
        label="Include Adventure Labs"
        checked={a.include}
        onChange={(include) => set({ include })}
      />
      <Check
        label="Adventure Labs: all stages or none"
        checked={a.keepTogether}
        onChange={(keepTogether) => set({ keepTogether })}
      />
      <Check
        label="Allow Adventure Lab stages to interleave"
        checked={a.interleave}
        onChange={(interleave) => set({ interleave })}
      />
    </fieldset>
  );
}

export function TimeSection(props: SectionProps): JSX.Element {
  const [t, set] = useGroup(props, "time");
  return (
    <div className="field">
      <label>
        Visit time per cache (min): {t.visitMinutes}
        <input
          type="range"
          min={0}
          max={60}
          step={1}
          value={t.visitMinutes}
          onChange={(e) => set({ visitMinutes: Number(e.target.value) })}
        />
      </label>
      <details className="settings-per-type">
        <summary>Visit time per cache type</summary>
        {CACHE_TYPES.filter((ct) => ct !== "Adventure Lab").map((ct) => (
          <label key={ct} className="settings-per-type__row">
            <span>{ct}</span>
            <input
              type="number"
              min={0}
              max={240}
              placeholder={String(t.visitMinutes)}
              value={t.visitMinutesByType[ct] ?? ""}
              onChange={(e) => {
                const next = { ...t.visitMinutesByType };
                if (e.target.value === "") delete next[ct];
                else
                  next[ct] = Math.min(
                    240,
                    Math.max(0, Math.round(Number(e.target.value))),
                  );
                set({ visitMinutesByType: next });
              }}
            />
          </label>
        ))}
        <small className="muted">Blank = the visit time above.</small>
      </details>
      <label>
        Visit time per Adventure Lab stage (min): {t.alStageVisitMinutes}
        <input
          type="range"
          min={0}
          max={30}
          step={1}
          value={t.alStageVisitMinutes}
          onChange={(e) => set({ alStageVisitMinutes: Number(e.target.value) })}
        />
      </label>
      <label>
        Extra time for tool caches (min): {t.toolBonusMinutes}
        <input
          type="range"
          min={0}
          max={30}
          step={1}
          value={t.toolBonusMinutes}
          onChange={(e) => set({ toolBonusMinutes: Number(e.target.value) })}
        />
      </label>
      <label>
        Avg walking speed (km/h): {t.walkingKmh.toFixed(1)}
        <input
          type="range"
          min={2}
          max={8}
          step={0.1}
          value={t.walkingKmh}
          onChange={(e) => set({ walkingKmh: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}

const START_PREFERENCES: ReadonlyArray<readonly [StartPreference, string]> = [
  ["auto", "Automatic (recommended)"],
  ["parking-waypoint", "Cache-owner parking"],
  ["osm-parking", "Public parking lots"],
  ["osrm-nearest-road", "Nearest road I can drive to"],
  ["user-supplied-point", "Pick a point on the map"],
];

export interface ParkingSectionProps extends SectionProps {
  /** Planner-only UI under the "pick a point" option (the picked start). */
  pickPointExtras?: ReactNode;
}

export function ParkingSection({
  pickPointExtras,
  ...props
}: ParkingSectionProps): JSX.Element {
  const [p, set] = useGroup(props, "parking");
  return (
    <fieldset className="field">
      <legend>Start preference</legend>
      {START_PREFERENCES.map(([val, label]) => (
        <label key={val} className="checkbox">
          <input
            type="radio"
            name="start-preference"
            checked={p.startPreference === val}
            onChange={() => set({ startPreference: val })}
          />
          {label}
        </label>
      ))}
      {p.startPreference === "osm-parking" && (
        <div className="osm-parking-filters" style={{ marginTop: 8 }}>
          <div style={{ marginBottom: 6 }}>
            <span className="muted" style={{ marginRight: 8 }}>
              Access
            </span>
            {PARKING_ACCESS_CHIPS.map((chip) => {
              const on = p.osmAccess.includes(chip);
              return (
                <label
                  key={chip}
                  className="checkbox"
                  style={{ display: "inline-block", marginRight: 6 }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      set({
                        osmAccess: on
                          ? p.osmAccess.filter((c) => c !== chip)
                          : [...p.osmAccess, chip],
                      })
                    }
                  />
                  {chip}
                </label>
              );
            })}
          </div>
          <div>
            <span className="muted" style={{ marginRight: 8 }}>
              Fee
            </span>
            {PARKING_FEE_FILTER.map((opt) => (
              <label
                key={opt}
                className="checkbox"
                style={{ display: "inline-block", marginRight: 6 }}
              >
                <input
                  type="radio"
                  name="osm-parking-fee"
                  checked={p.osmFee === opt}
                  onChange={() => set({ osmFee: opt })}
                />
                {opt}
              </label>
            ))}
          </div>
        </div>
      )}
      {p.startPreference === "user-supplied-point" && pickPointExtras}
    </fieldset>
  );
}

const STRATEGY_OPTIONS: ReadonlyArray<
  readonly [ClusteringStrategyName, string]
> = [
  ["hdbscan-star", "HDBSCAN* (default)"],
  ["louvain", "Louvain (community)"],
  ["leiden", "Leiden (connected)"],
  ["dbscan", "DBSCAN"],
  ["hdbscan", "HDBSCAN (density)"],
  ["components", "Components (baseline)"],
];

export function AdvancedSettingsSection(props: SectionProps): JSX.Element {
  const [a, set] = useGroup(props, "advanced");
  return (
    <AdvancedSection title="Advanced settings">
      <div className="field">
        <label>
          Min caches per cluster: {a.minClusterSize}
          <input
            type="range"
            min={2}
            max={50}
            step={1}
            value={a.minClusterSize}
            onChange={(e) => set({ minClusterSize: Number(e.target.value) })}
          />
        </label>
        <label>
          Clusters to show: {a.topNClusters}
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={a.topNClusters}
            onChange={(e) => set({ topNClusters: Number(e.target.value) })}
          />
        </label>
        <label>
          Max gap between caches: {a.maxLinkMeters.toLocaleString("en-US")} m
          <input
            type="range"
            min={200}
            max={5_000}
            step={100}
            value={a.maxLinkMeters}
            onChange={(e) => set({ maxLinkMeters: Number(e.target.value) })}
          />
          <small className="muted">
            Caches farther apart than this on foot aren&rsquo;t linked into the
            same loop.
          </small>
        </label>
        <label>
          Trim out-and-back spurs: {a.fringeTrimMeters} m
          <input
            type="range"
            min={100}
            max={3_000}
            step={50}
            value={a.fringeTrimMeters}
            onChange={(e) => set({ fringeTrimMeters: Number(e.target.value) })}
          />
          <small className="muted">
            Drop a cache whose in-and-out path retraces more than this much of
            itself (a dead-end spur).
          </small>
        </label>
      </div>
      <fieldset className="field">
        <legend>Clustering algorithm</legend>
        {STRATEGY_OPTIONS.map(([val, label]) => (
          <label key={val} className="checkbox">
            <input
              type="radio"
              name="clustering-strategy"
              checked={a.clusteringStrategy === val}
              onChange={() => set({ clusteringStrategy: val })}
            />
            {label}
          </label>
        ))}
      </fieldset>
    </AdvancedSection>
  );
}

/** The whole form in reading order — the profile editor. */
export function AllSettingsSections(props: SectionProps): JSX.Element {
  return (
    <>
      <h3 className="settings-heading">Which caches</h3>
      <SearchAreaSection {...props} />
      <CacheFiltersSection {...props} />
      <h3 className="settings-heading">The walk</h3>
      <BudgetSection {...props} />
      <InterestSection {...props} />
      <AdventureLabsSection {...props} />
      <TimeSection {...props} />
      <ParkingSection {...props} />
      <AdvancedSettingsSection {...props} />
    </>
  );
}

/* --- small controls ------------------------------------------------------- */

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function Weight({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label>
      {label}: {value.toFixed(1)}
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

function TypeChecks({
  name,
  value,
  onChange,
}: {
  name: string;
  value: readonly CacheType[];
  onChange: (v: CacheType[]) => void;
}): JSX.Element {
  return (
    <>
      {CACHE_TYPES.map((t) => (
        <label key={t} className="checkbox">
          <input
            type="checkbox"
            name={name}
            checked={value.includes(t)}
            onChange={() =>
              onChange(
                value.includes(t)
                  ? value.filter((x) => x !== t)
                  : [...value, t],
              )
            }
          />
          {t}
        </label>
      ))}
    </>
  );
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function labelForKind(k: LanduseKind): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}
