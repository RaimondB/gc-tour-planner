// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState } from "react";
import { CACHE_TYPES, type CacheType } from "@gctp/shared/caches";
import type { SearchParams } from "../../lib/search-params.js";

export interface FilterSidebarProps {
  value: SearchParams;
  onChange: (next: SearchParams) => void;
  cacheCount: number | undefined;
  loading: boolean;
}

export function FilterSidebar({
  value,
  onChange,
  cacheCount,
  loading,
}: FilterSidebarProps) {
  // Local draft so number inputs don't fight the user mid-keystroke.
  const [lng, setLng] = useState(String(value.center[0]));
  const [lat, setLat] = useState(String(value.center[1]));

  const commitCenter = () => {
    const nLng = Number(lng);
    const nLat = Number(lat);
    if (Number.isFinite(nLng) && Number.isFinite(nLat)) {
      onChange({ ...value, center: [nLng, nLat] });
    }
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
        setLng(String(c[0]));
        setLat(String(c[1]));
        onChange({ ...value, center: c });
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
            type="number"
            step="0.0001"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            onBlur={commitCenter}
          />
        </label>
        <label>
          Latitude
          <input
            type="number"
            step="0.0001"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            onBlur={commitCenter}
          />
        </label>
        <button type="button" onClick={useMyLocation}>
          Use my location
        </button>
      </div>

      <div className="field">
        <label>
          Radius (m): {value.radiusM.toLocaleString()}
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
