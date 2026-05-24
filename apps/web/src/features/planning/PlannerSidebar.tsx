// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CacheDTO } from "@gctp/shared/caches";
import type {
  ClusterCandidate,
  ClusterDiagnostics,
  PlanResult,
  StartPreference,
} from "@gctp/shared/tours";
import { discoverClusters, planLoop } from "../../lib/api.js";
import type { SearchParams } from "../../lib/search-params.js";

export interface PlanSettings {
  distanceBudgetMeters: number;
  maxCaches: number;
  /** Floor on cluster size; raising it produces fewer, larger clusters. */
  minClusterSize: number;
  /** Max walking distance (m) for two caches to link into the same cluster. */
  maxLinkMeters: number;
  startPreference: StartPreference;
  /** Per-cache visit time used in time totals. */
  timePerCacheMinutes: number;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  distanceBudgetMeters: 8_000,
  maxCaches: 15,
  minClusterSize: 8,
  maxLinkMeters: 1_500,
  startPreference: "parking-waypoint",
  timePerCacheMinutes: 5,
};

export interface PlannerSidebarProps {
  search: SearchParams;
  settings: PlanSettings;
  onSettingsChange: (next: PlanSettings) => void;
  clusters: ClusterCandidate[] | null;
  onClustersChange: (next: ClusterCandidate[] | null) => void;
  diagnostics: ClusterDiagnostics | null;
  onDiagnosticsChange: (next: ClusterDiagnostics | null) => void;
  chosenClusterId: string | null;
  onChosenClusterChange: (id: string | null) => void;
  focusedClusterId: string | null;
  /**
   * Notify the parent when the user hovers/focuses a cluster row, so the map
   * can fly to it and render a cheap preview polyline. `null` clears focus.
   */
  onFocusClusterChange: (id: string | null) => void;
  result: PlanResult | null;
  onResultChange: (next: PlanResult | null) => void;
  /** Caches currently in the search radius — used for the JSON debug export. */
  caches: readonly CacheDTO[] | undefined;
}

export function PlannerSidebar({
  search,
  settings,
  onSettingsChange,
  clusters,
  onClustersChange,
  diagnostics,
  onDiagnosticsChange,
  chosenClusterId,
  onChosenClusterChange,
  focusedClusterId,
  onFocusClusterChange,
  result,
  onResultChange,
  caches,
}: PlannerSidebarProps) {
  const discoverMutation = useMutation({
    mutationFn: async () => {
      return discoverClusters({
        center: search.center,
        radiusM: search.radiusM,
        maxCaches: settings.maxCaches,
        minClusterSize: settings.minClusterSize,
        maxLinkMeters: settings.maxLinkMeters,
        distanceBudgetMeters: settings.distanceBudgetMeters,
        hardFilters: {
          types: search.types.length > 0 ? search.types : undefined,
        },
        softPreferences: {
          clusterDensityWeight: 1,
          loopCompactnessWeight: 1,
        },
        startPreference: settings.startPreference,
        ...(settings.startPreference === "user-supplied-point"
          ? { userSuppliedStart: search.center }
          : {}),
      });
    },
    onSuccess: (res) => {
      onClustersChange(res.candidates);
      onDiagnosticsChange(res.diagnostics);
      onChosenClusterChange(null);
      onResultChange(null);
    },
  });

  const planMutation = useMutation({
    mutationFn: async (cluster: ClusterCandidate) => {
      onChosenClusterChange(cluster.clusterId);
      return planLoop({
        cacheIds: cluster.cacheIds,
        distanceBudgetMeters: settings.distanceBudgetMeters,
        timePerCacheMinutes: settings.timePerCacheMinutes,
        startPreference: settings.startPreference,
        ...(settings.startPreference === "user-supplied-point"
          ? { userSuppliedStart: search.center }
          : {}),
      });
    },
    onSuccess: (res) => onResultChange(res),
  });

  const clearAll = () => {
    onClustersChange(null);
    onDiagnosticsChange(null);
    onChosenClusterChange(null);
    onFocusClusterChange(null);
    onResultChange(null);
  };

  const exportJson = () => {
    const clusteredIds = new Set<number>();
    for (const c of clusters ?? []) for (const id of c.cacheIds) clusteredIds.add(id);
    const payload = {
      exportedAt: new Date().toISOString(),
      search: {
        center: search.center,
        radiusM: search.radiusM,
        types: search.types,
        excludeFound: search.excludeFound,
        contexts: search.contexts,
      },
      settings,
      caches: caches ?? [],
      clusters: clusters ?? [],
      // Caches that survived the radius+filter query but were not placed in
      // any cluster — either they failed the ε-link or their connected
      // component was below `minClusterSize` or got dropped by the trim step.
      // This is what's most useful for the "why didn't X cluster" debug loop.
      noiseCacheIds: (caches ?? [])
        .map((c) => c.id)
        .filter((id) => !clusteredIds.has(id)),
      // Pre-trim components + per-cache nearest walkable neighbor. The
      // diagnostics tell you whether the issue is "lots of small components
      // below minClusterSize" or "caches truly unreachable on foot".
      diagnostics,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `gctp-planner-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Scroll the focused cluster row into view when focus is set externally
  // (i.e. by clicking a centroid on the map). Idempotent — if the row is
  // already visible, scrollIntoView is a no-op.
  const rowRefs = useRef(new Map<string, HTMLLIElement | null>());
  useEffect(() => {
    if (!focusedClusterId) return;
    const el = rowRefs.current.get(focusedClusterId);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusedClusterId]);

  return (
    <aside className="sidebar planner-sidebar">
      <h2>Plan a tour</h2>

      <div className="field">
        <label>
          Distance budget (m):{" "}
          {settings.distanceBudgetMeters.toLocaleString("en-US")}
          <input
            type="range"
            min={1_000}
            max={25_000}
            step={500}
            value={settings.distanceBudgetMeters}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                distanceBudgetMeters: Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Max caches: {settings.maxCaches}
          <input
            type="range"
            min={2}
            max={50}
            step={1}
            value={settings.maxCaches}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                maxCaches: Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Min cluster size: {settings.minClusterSize}
          <input
            type="range"
            min={2}
            max={Math.max(2, settings.maxCaches)}
            step={1}
            value={settings.minClusterSize}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                minClusterSize: Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Max link distance (m):{" "}
          {settings.maxLinkMeters.toLocaleString("en-US")}
          <input
            type="range"
            min={200}
            max={5_000}
            step={100}
            value={settings.maxLinkMeters}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                maxLinkMeters: Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Visit time per cache (min): {settings.timePerCacheMinutes}
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={settings.timePerCacheMinutes}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                timePerCacheMinutes: Number(e.target.value),
              })
            }
          />
        </label>
      </div>

      <fieldset className="field">
        <legend>Start preference</legend>
        {(
          [
            ["parking-waypoint", "Cache-owner parking (PQ)"],
            ["osrm-nearest-road", "OSRM nearest road"],
            ["user-supplied-point", "Use current search center"],
          ] as const
        ).map(([val, label]) => (
          <label key={val} className="checkbox">
            <input
              type="radio"
              name="start-preference"
              checked={settings.startPreference === val}
              onChange={() =>
                onSettingsChange({ ...settings, startPreference: val })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>

      <div className="planner-actions">
        <button
          type="button"
          onClick={() => discoverMutation.mutate()}
          disabled={discoverMutation.isPending}
        >
          {discoverMutation.isPending ? "Searching…" : "Discover clusters"}
        </button>
        <button
          type="button"
          onClick={clearAll}
          disabled={clusters === null && result === null}
        >
          Clear
        </button>
        <button
          type="button"
          onClick={exportJson}
          disabled={!caches || caches.length === 0}
          title="Download the current search + caches + clusters as JSON for offline analysis"
        >
          Export JSON
        </button>
      </div>

      {discoverMutation.error && (
        <div className="planner-error">
          {(discoverMutation.error as Error).message}
        </div>
      )}

      {clusters !== null && clusters.length === 0 && (
        <div className="planner-empty">
          No clusters found in this area. Try widening the radius or loosening
          the filters.
        </div>
      )}

      {clusters && clusters.length > 0 && (
        <div className="cluster-picker">
          <h3>Candidate clusters</h3>
          <ol>
            {clusters.map((c, i) => (
              <li
                key={c.clusterId}
                ref={(el) => rowRefs.current.set(c.clusterId, el)}
                className={[
                  "cluster",
                  c.clusterId === chosenClusterId ? "picked" : "",
                  c.clusterId === focusedClusterId ? "focused" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                // Focus is sticky — set on hover or via map-centroid click,
                // only changes when the user picks a different row or clears.
                onMouseEnter={() => onFocusClusterChange(c.clusterId)}
                onFocus={() => onFocusClusterChange(c.clusterId)}
                tabIndex={0}
              >
                <div className="cluster-head">
                  <span className="cluster-rank">#{i + 1}</span>
                  <span className="cluster-caches">
                    {c.cacheIds.length} caches
                  </span>
                  <span className="cluster-mst">
                    MST {(c.mstLengthMeters / 1000).toFixed(2)} km
                  </span>
                  <span className="cluster-score">
                    score {c.score.toFixed(3)}
                  </span>
                </div>
                <div className="cluster-breakdown">
                  {Object.entries(c.scoreBreakdown).map(([k, v]) => (
                    <span key={k} className="chip">
                      {k}: {v.toFixed(2)}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => planMutation.mutate(c)}
                  disabled={planMutation.isPending}
                >
                  {planMutation.isPending && c.clusterId === chosenClusterId
                    ? "Planning…"
                    : "Plan this loop"}
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {planMutation.error && (
        <div className="planner-error">
          {(planMutation.error as Error).message}
        </div>
      )}

      {result && <PlanResultPanel result={result} />}
    </aside>
  );
}

function PlanResultPanel({ result }: { result: PlanResult }) {
  return (
    <div className="plan-result">
      <h3>Planned loop</h3>
      <dl className="totals">
        <dt>Distance</dt>
        <dd>{(result.totals.meters / 1000).toFixed(2)} km</dd>
        <dt>Walking time</dt>
        <dd>{minutes(result.totals.seconds / 60)}</dd>
        <dt>Visit time</dt>
        <dd>{minutes(result.totals.visitMinutes)}</dd>
        <dt>Total time</dt>
        <dd>{minutes(result.totals.seconds / 60 + result.totals.visitMinutes)}</dd>
        <dt>Caches</dt>
        <dd>{result.orderedCacheIds.length}</dd>
        <dt>Parking</dt>
        <dd>
          <strong>{labelForParking(result.parking.type)}</strong>
          <br />
          <small>{result.parking.reason}</small>
        </dd>
      </dl>
      <h4>Score breakdown</h4>
      <ul className="breakdown">
        {Object.entries(result.scoreBreakdown).map(([k, v]) => (
          <li key={k}>
            <span className="key">{k}</span>
            <span className="val">{v.toLocaleString("en-US")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function minutes(m: number): string {
  if (!Number.isFinite(m) || m < 0) return "—";
  const h = Math.floor(m / 60);
  const mm = Math.round(m - h * 60);
  if (h === 0) return `${mm} min`;
  return `${h} h ${mm.toString().padStart(2, "0")} min`;
}

function labelForParking(t: PlanResult["parking"]["type"]): string {
  switch (t) {
    case "pq":
      return "Cache-owner parking (PQ)";
    case "osrm-nearest":
      return "OSRM nearest road";
    case "user":
      return "User-supplied point";
  }
}
