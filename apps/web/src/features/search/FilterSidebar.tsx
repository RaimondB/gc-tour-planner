// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";
import type { RouteProfileSettings } from "@gctp/shared/route-profiles";
import type { SearchParams } from "../../lib/search-params.js";
import {
  CacheFiltersSection,
  SearchAreaSection,
} from "../settings/SettingsSections.js";

export interface FilterSidebarProps {
  value: SearchParams;
  /**
   * `opts.fly` requests that the map camera fly to the new center
   * (set when the user explicitly invokes "Use my location"). Map-click
   * recenter and manual input changes both leave the camera alone.
   */
  onChange: (next: SearchParams, opts?: { fly?: boolean }) => void;
  /** The planner's settings in profile shape — filters + radius live here. */
  profile: RouteProfileSettings;
  onProfileChange: (next: RouteProfileSettings) => void;
  cacheCount: number | undefined;
  loading: boolean;
}

export function FilterSidebar({
  value,
  onChange,
  profile,
  onProfileChange,
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

      <SearchAreaSection value={profile} onChange={onProfileChange} />
      <CacheFiltersSection
        value={profile}
        onChange={onProfileChange}
        landuseExtras={
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
        }
      />

      <div className="result-count">
        {loading
          ? "Loading…"
          : cacheCount === undefined
            ? "—"
            : `${cacheCount} cache${cacheCount === 1 ? "" : "s"} in radius`}
      </div>

      {!loading && !cacheCount && (
        <div className="empty-hint">
          No caches here yet. <strong>Upload a GPX</strong> above to load your
          caches, or widen the radius / move the search center (click the map or
          drag the center handle). Then press <strong>Find clusters →</strong>.
        </div>
      )}
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
