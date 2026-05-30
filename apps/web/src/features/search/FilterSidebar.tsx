// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";
import { CACHE_TYPES, type CacheType } from "@gctp/shared/caches";
import { LANDUSE_KINDS, type LanduseKind } from "@gctp/shared/landuse";
import type { SearchParams } from "../../lib/search-params.js";

export interface FilterSidebarProps {
  value: SearchParams;
  /**
   * `opts.fly` requests that the map camera fly to the new center
   * (set when the user explicitly invokes "Use my location"). Map-click
   * recenter and manual input changes both leave the camera alone.
   */
  onChange: (next: SearchParams, opts?: { fly?: boolean }) => void;
  cacheCount: number | undefined;
  loading: boolean;
}

export function FilterSidebar({
  value,
  onChange,
  cacheCount,
  loading,
}: FilterSidebarProps) {
  // Local draft so the user can type freely without round-tripping every
  // keystroke through the parent's state.
  const [lng, setLng] = useState(formatCoord(value.center[0]));
  const [lat, setLat] = useState(formatCoord(value.center[1]));

  // Sync drafts when the parent's center changes (map click, geolocate).
  // We compare numerically so a parent-side normalisation doesn't fight the
  // user — only update when the underlying value really differs.
  useEffect(() => {
    setLng((prev) =>
      Number(prev.replace(",", ".")) === value.center[0]
        ? prev
        : formatCoord(value.center[0]),
    );
    setLat((prev) =>
      Number(prev.replace(",", ".")) === value.center[1]
        ? prev
        : formatCoord(value.center[1]),
    );
  }, [value.center]);

  const commitCenter = () => {
    const nLng = parseCoord(lng);
    const nLat = parseCoord(lat);
    if (nLng === null || nLat === null) return;
    if (nLng === value.center[0] && nLat === value.center[1]) return;
    onChange({ ...value, center: [nLng, nLat] });
  };

  const toggleType = (t: CacheType) => {
    const isOn = value.types.includes(t);
    onChange({
      ...value,
      types: isOn ? value.types.filter((x) => x !== t) : [...value.types, t],
    });
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        setLng(formatCoord(c[0]));
        setLat(formatCoord(c[1]));
        onChange({ ...value, center: c }, { fly: true });
      },
      undefined,
      { enableHighAccuracy: false, timeout: 8_000 },
    );
  };

  return (
    <aside className="sidebar">
      <h2>Search</h2>

      <div className="field">
        <label>
          Longitude
          <input
            type="text"
            inputMode="decimal"
            // `lang="en"` keeps any browser-localised number widgets dot-only.
            lang="en"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            onBlur={commitCenter}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
        <label>
          Latitude
          <input
            type="text"
            inputMode="decimal"
            lang="en"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            onBlur={commitCenter}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
        <button type="button" onClick={useMyLocation}>
          Use my location
        </button>
        <small>Click the map to set the search center.</small>
      </div>

      <div className="field">
        <label>
          Radius (m): {value.radiusM.toLocaleString("en-US")}
          <input
            type="range"
            min={500}
            max={50_000}
            step={500}
            value={value.radiusM}
            onChange={(e) =>
              onChange({ ...value, radiusM: Number(e.target.value) })
            }
          />
        </label>
      </div>

      <fieldset className="field">
        <legend>Cache types</legend>
        {CACHE_TYPES.map((t) => (
          <label key={t} className="checkbox">
            <input
              type="checkbox"
              checked={value.types.includes(t)}
              onChange={() => toggleType(t)}
            />
            {t}
          </label>
        ))}
        <small>No selection = any type</small>
        {value.types.includes("Multi") && (
          <div className="filter-sub" style={{ marginTop: 6 }}>
            <small style={{ display: "block", marginBottom: 2 }}>
              Multi sub-type
            </small>
            {(
              [
                ["all", "All"],
                ["field-puzzle", "Field-puzzle (stages unknown)"],
                ["mini", "Mini-multi (1–2 stages)"],
                ["full", "Full multi (3+ stages)"],
              ] as const
            ).map(([val, label]) => (
              <label key={val} className="checkbox">
                <input
                  type="radio"
                  name="multi-subtype"
                  checked={value.multiSubtype === val}
                  onChange={() => onChange({ ...value, multiSubtype: val })}
                />
                {label}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="field">
        <legend>My finds</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={value.excludeFound}
            onChange={(e) =>
              onChange({ ...value, excludeFound: e.target.checked })
            }
          />
          Exclude caches I have found
        </label>
        <small>
          Upload a Groundspeak &ldquo;My Finds&rdquo; GPX with the toggle below,
          or mark caches one-by-one from the map popup.
        </small>
      </fieldset>

      <fieldset className="field">
        <legend>Availability</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={value.includeDisabled}
            onChange={(e) =>
              onChange({ ...value, includeDisabled: e.target.checked })
            }
          />
          Include temporarily-disabled caches
        </label>
        <small>
          Disabled caches are temporarily out of service (owner maintenance).
          Hidden by default; when shown they render at 50 % opacity with a
          &ldquo;Z&rdquo; overlay. Archived caches are always hidden.
        </small>
      </fieldset>

      <fieldset className="field">
        <legend>Equipment</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={value.hideToolCaches}
            onChange={(e) =>
              onChange({ ...value, hideToolCaches: e.target.checked })
            }
          />
          Hide caches requiring special tools
        </label>
        <small>
          Excludes caches with attributes like climbing gear, boat, scuba,
          flashlight, snowshoes, or &ldquo;special tool required&rdquo; (e.g.
          angler pole). Also catches caches whose description mentions a tool
          (fishing rod, ladder, mirror, &hellip;) in en/nl/de.
        </small>
      </fieldset>

      <fieldset className="field">
        <legend>Landuse context</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={value.showLanduse}
            onChange={(e) =>
              onChange({ ...value, showLanduse: e.target.checked })
            }
          />
          Show landuse overlay
        </label>
        {value.showLanduse && (
          <>
            {LANDUSE_KINDS.map((k) => (
              <label key={k} className="checkbox">
                <input
                  type="checkbox"
                  checked={value.contexts.includes(k)}
                  onChange={() => {
                    const isOn = value.contexts.includes(k);
                    onChange({
                      ...value,
                      contexts: isOn
                        ? value.contexts.filter((c) => c !== k)
                        : [...value.contexts, k],
                    });
                  }}
                />
                {labelForKind(k)}
              </label>
            ))}
            <small>
              Pick one or more to hard-filter caches to those areas. Polygons
              are fetched from OpenStreetMap on demand.
            </small>
          </>
        )}
      </fieldset>

      <div className="result-count">
        {loading
          ? "Loading…"
          : cacheCount === undefined
            ? "—"
            : `${cacheCount} cache${cacheCount === 1 ? "" : "s"} in radius`}
      </div>
    </aside>
  );
}

/** Always uses `.` as decimal separator. */
function formatCoord(n: number): string {
  // String(num) is locale-independent — never produces a comma.
  return String(n);
}

/** Accepts `.` or `,` decimal separators; returns null on invalid input. */
function parseCoord(raw: string): number | null {
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function labelForKind(k: LanduseKind): string {
  switch (k) {
    case "forest":
      return "Forest";
    case "park":
      return "Park";
    case "residential":
      return "Residential";
    case "farmland":
      return "Farmland";
    case "industrial":
      return "Industrial";
    case "meadow":
      return "Meadow";
    case "water":
      return "Water";
    case "wetland":
      return "Wetland";
    case "heath":
      return "Heath";
    case "scrub":
      return "Scrub";
  }
}
