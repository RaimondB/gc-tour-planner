// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CacheDTO } from "@gctp/shared/caches";
import type {
  ClusterCandidate,
  ClusterDiagnostics,
  ClusteringStrategyName,
  PlanResult,
  StartPreference,
  TestRouteResponse,
  WalkingGraphResponse,
} from "@gctp/shared/tours";
import {
  discoverClusters,
  explainSelection,
  planLoop,
  purgeBogusWalkingCells,
  testOsrmRoute,
} from "../../lib/api.js";
import { useQueryClient } from "@tanstack/react-query";
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
  /**
   * Walking pace used to convert planned distance into walking time. Lets
   * the user override OSRM's foot-profile default (~5 km/h) without
   * re-planning — purely a display concern, recomputed on the client.
   */
  avgWalkingKmh: number;
  /**
   * Pass-1 clustering algorithm. Swap to compare strategies on the same
   * `PlanInput` — see `ClusteringStrategyName` for available options.
   */
  clusteringStrategy: ClusteringStrategyName;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  distanceBudgetMeters: 8_000,
  maxCaches: 15,
  minClusterSize: 8,
  maxLinkMeters: 1_500,
  startPreference: "parking-waypoint",
  timePerCacheMinutes: 5,
  avgWalkingKmh: 5,
  clusteringStrategy: "louvain",
};

const STRATEGY_OPTIONS: ReadonlyArray<readonly [ClusteringStrategyName, string]> = [
  ["louvain", "Louvain (default)"],
  ["dbscan", "DBSCAN"],
  ["hdbscan", "HDBSCAN (density)"],
  ["components", "Components (baseline)"],
];

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
  /** Manually selected cache ids (shift-click on the map). Used by Cluster Lab. */
  selectedCacheIds: ReadonlySet<number>;
  onSelectionChange: (next: ReadonlySet<number>) => void;
  /** Toggle the OSRM walking-graph debug overlay on the map. */
  showWalkingGraph: boolean;
  onShowWalkingGraphChange: (next: boolean) => void;
  /** Stats from the most recent walking-graph fetch (null when overlay is off). */
  walkingGraphStats: WalkingGraphResponse["stats"] | null;
  /** Last live OSRM /route probe — rendered as a green polyline on the map. */
  testRoute: TestRouteResponse | null;
  onTestRouteChange: (next: TestRouteResponse | null) => void;
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
  selectedCacheIds,
  onSelectionChange,
  showWalkingGraph,
  onShowWalkingGraphChange,
  walkingGraphStats,
  testRoute,
  onTestRouteChange,
}: PlannerSidebarProps) {
  const queryClient = useQueryClient();
  const purgeBogusMutation = useMutation({
    mutationFn: async () => {
      return purgeBogusWalkingCells({
        center: search.center,
        radiusM: search.radiusM,
        hardFilters: {
          types: search.types.length > 0 ? search.types : undefined,
        },
        maxLinkMeters: settings.maxLinkMeters,
        distanceBudgetMeters: settings.distanceBudgetMeters,
      });
    },
    onSuccess: () => {
      // Force a fresh walking-graph fetch so the overlay reflects post-purge state.
      void queryClient.invalidateQueries({ queryKey: ["walking-graph"] });
    },
  });

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
        clusteringStrategy: settings.clusteringStrategy,
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
        <label>
          Avg walking speed (km/h): {settings.avgWalkingKmh.toFixed(1)}
          <input
            type="range"
            min={2}
            max={8}
            step={0.1}
            value={settings.avgWalkingKmh}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                avgWalkingKmh: Number(e.target.value),
              })
            }
          />
        </label>
      </div>

      <fieldset className="field">
        <legend>Clustering algorithm</legend>
        {STRATEGY_OPTIONS.map(([val, label]) => (
          <label key={val} className="checkbox">
            <input
              type="radio"
              name="clustering-strategy"
              checked={settings.clusteringStrategy === val}
              onChange={() =>
                onSettingsChange({ ...settings, clusteringStrategy: val })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>

      <fieldset className="field">
        <legend>Debug overlays</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={showWalkingGraph}
            onChange={(e) => onShowWalkingGraphChange(e.target.checked)}
          />
          Show walking graph (blue lines = OSRM walking edges)
        </label>
        {showWalkingGraph && walkingGraphStats && (
          <div className="cluster-lab-hint">
            {walkingGraphStats.nodeCount} nodes · {walkingGraphStats.edgeCount} edges
            {walkingGraphStats.isolatedCount > 0 && (
              <> · {walkingGraphStats.isolatedCount} isolated</>
            )}
            {walkingGraphStats.suspiciousCount > 0 && (
              <>
                {" · "}
                <strong style={{ color: "#d50000" }}>
                  {walkingGraphStats.suspiciousCount} suspicious zero-distance
                </strong>{" "}
                (dashed red — likely stale <code>route_legs</code> rows)
              </>
            )}
            <br />
            median {walkingGraphStats.medianEdgeM.toFixed(0)} m · max {walkingGraphStats.maxEdgeM.toFixed(0)} m ·
            detour ratio {walkingGraphStats.medianDetourRatio.toFixed(2)}×
            {walkingGraphStats.highDetourCount > 0 && (
              <> · {walkingGraphStats.highDetourCount} high-detour</>
            )}
            {walkingGraphStats.coverageWarning && (
              <div
                style={{
                  marginTop: 6,
                  padding: "6px 8px",
                  border: "1px solid #ff6f00",
                  borderRadius: 4,
                  background: "#fff8e1",
                }}
              >
                <strong style={{ color: "#ff6f00" }}>OSRM coverage warning.</strong>{" "}
                Many edges show large walking-vs-straight-line detours
                (median {walkingGraphStats.medianDetourRatio.toFixed(2)}×).
                Likely cause: <code>OSRM_REGION</code> doesn't fully cover
                this area. For cross-border searches set{" "}
                <code>OSRM_REGIONS</code> (plural) to a comma-separated list
                of Geofabrik extracts — the bootstrap will <code>osmium merge</code>{" "}
                them before extract.
              </div>
            )}
            {walkingGraphStats.suspiciousCount > 0 && (
              <div style={{ marginTop: 6 }}>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete ${walkingGraphStats.suspiciousCount} suspicious zero-distance route_legs rows? ` +
                          `The next planner pass will refetch from OSRM.`,
                      )
                    ) {
                      purgeBogusMutation.mutate();
                    }
                  }}
                  disabled={purgeBogusMutation.isPending}
                >
                  {purgeBogusMutation.isPending
                    ? "Purging…"
                    : `Purge ${walkingGraphStats.suspiciousCount} bogus edges`}
                </button>
                {purgeBogusMutation.data && (
                  <span style={{ marginLeft: 8 }}>
                    Deleted {purgeBogusMutation.data.deletedCount} rows.
                  </span>
                )}
                {purgeBogusMutation.error && (
                  <span style={{ marginLeft: 8, color: "#d50000" }}>
                    {(purgeBogusMutation.error as Error).message}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </fieldset>

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
                <div className="cluster-row-actions">
                  <button
                    type="button"
                    onClick={() => planMutation.mutate(c)}
                    disabled={planMutation.isPending}
                  >
                    {planMutation.isPending && c.clusterId === chosenClusterId
                      ? "Planning…"
                      : "Plan this loop"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectionChange(new Set(c.cacheIds))}
                    title="Copy this cluster into the manual selection so you can shift-click caches off and re-explain"
                  >
                    Use as selection
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      <ClusterLabPanel
        search={search}
        settings={settings}
        selectedCacheIds={selectedCacheIds}
        onSelectionChange={onSelectionChange}
        testRoute={testRoute}
        onTestRouteChange={onTestRouteChange}
      />


      {planMutation.error && (
        <div className="planner-error">
          {(planMutation.error as Error).message}
        </div>
      )}

      {result && (
        <PlanResultPanel
          result={result}
          avgWalkingKmh={settings.avgWalkingKmh}
        />
      )}
    </aside>
  );
}

function PlanResultPanel({
  result,
  avgWalkingKmh,
}: {
  result: PlanResult;
  avgWalkingKmh: number;
}) {
  const km = result.totals.meters / 1000;
  // Convert distance → walking minutes at the user's pace. OSRM's own seconds
  // were profile-default (~5 km/h) — we ignore them so the user sees their
  // own pace's totals without having to re-run /tours/plan.
  const walkingMin =
    avgWalkingKmh > 0 ? (km / avgWalkingKmh) * 60 : Number.POSITIVE_INFINITY;
  const visitMin = result.totals.visitMinutes;
  const totalMin = walkingMin + visitMin;

  const downloadPlan = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `gctp-plan-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="plan-result">
      <h3>Planned loop</h3>
      <div className="plan-headline">
        <div>
          <span className="num">{km.toFixed(2)}</span>
          <span className="unit">km</span>
        </div>
        <div>
          <span className="num">{minutes(totalMin)}</span>
          <span className="unit">total</span>
        </div>
      </div>
      <dl className="totals">
        <dt>Walking</dt>
        <dd>
          {minutes(walkingMin)}{" "}
          <small>@ {avgWalkingKmh.toFixed(1)} km/h</small>
        </dd>
        <dt>Visit</dt>
        <dd>
          {minutes(visitMin)}{" "}
          <small>({result.orderedCacheIds.length} caches)</small>
        </dd>
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
      <div className="planner-actions">
        <button
          type="button"
          onClick={downloadPlan}
          title="Download the planned tour (ordered cache ids + per-leg polylines + score breakdown) as JSON for offline analysis"
        >
          Download plan JSON
        </button>
      </div>
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

interface ClusterLabPanelProps {
  search: SearchParams;
  settings: PlanSettings;
  selectedCacheIds: ReadonlySet<number>;
  onSelectionChange: (next: ReadonlySet<number>) => void;
  testRoute: TestRouteResponse | null;
  onTestRouteChange: (next: TestRouteResponse | null) => void;
}

/**
 * Cluster Lab — diagnose a manual cache selection (shift-click on the map)
 * via `POST /tours/clusters/explain`. Shows the JSON dump inline and lets
 * the user download it for offline analysis.
 *
 * Workflow:
 *   1. Shift-click 2+ cache markers (or "Use as selection" on a candidate row).
 *   2. Hit Explain — see per-strategy partitions + refinement projection.
 *   3. Shift-click selected markers to remove specific caches, hit Explain again.
 */
function ClusterLabPanel({
  search,
  settings,
  selectedCacheIds,
  onSelectionChange,
  testRoute,
  onTestRouteChange,
}: ClusterLabPanelProps) {
  const ids = Array.from(selectedCacheIds).sort((a, b) => a - b);
  const testRouteMutation = useMutation({
    mutationFn: async (pair: [number, number]) => {
      return testOsrmRoute({ fromCacheId: pair[0], toCacheId: pair[1] });
    },
    onSuccess: (res) => onTestRouteChange(res),
  });
  const explainMutation = useMutation({
    mutationFn: async () => {
      return explainSelection({
        center: search.center,
        radiusM: search.radiusM,
        hardFilters: {
          types: search.types.length > 0 ? search.types : undefined,
        },
        maxLinkMeters: settings.maxLinkMeters,
        minClusterSize: settings.minClusterSize,
        distanceBudgetMeters: settings.distanceBudgetMeters,
        clusteringStrategy: settings.clusteringStrategy,
        cacheIds: ids,
      });
    },
  });

  const copyIds = () => {
    void navigator.clipboard?.writeText(ids.join(","));
  };
  const clearSelection = () => {
    onSelectionChange(new Set());
    onTestRouteChange(null);
  };
  const downloadExplain = () => {
    if (!explainMutation.data) return;
    const blob = new Blob([JSON.stringify(explainMutation.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `gctp-explain-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (ids.length === 0) {
    return (
      <div className="cluster-lab">
        <h3>Cluster lab</h3>
        <p className="cluster-lab-hint">
          Hold Shift (or Ctrl / ⌘) and click cache markers on the map to
          build a manual selection, then explain why the algorithm did or
          didn't produce it. Watch the browser DevTools console for a
          <code>[cluster-lab]</code> log line on each click — if you don't
          see it, the marker isn't receiving the event.
        </p>
      </div>
    );
  }

  return (
    <div className="cluster-lab">
      <h3>Cluster lab ({ids.length} selected)</h3>
      <div className="planner-actions">
        <button
          type="button"
          onClick={() => explainMutation.mutate()}
          disabled={ids.length < 2 || explainMutation.isPending}
        >
          {explainMutation.isPending ? "Explaining…" : "Explain selection"}
        </button>
        <button type="button" onClick={copyIds}>
          Copy IDs
        </button>
        <button type="button" onClick={clearSelection}>
          Clear selection
        </button>
        <button
          type="button"
          onClick={downloadExplain}
          disabled={!explainMutation.data}
        >
          Download JSON
        </button>
        <button
          type="button"
          disabled={ids.length !== 2 || testRouteMutation.isPending}
          title={
            ids.length === 2
              ? "Ask OSRM directly for the foot route between these two caches (bypasses route_legs cache)"
              : "Select exactly 2 caches to test their OSRM route"
          }
          onClick={() => {
            if (ids.length === 2)
              testRouteMutation.mutate([ids[0]!, ids[1]!]);
          }}
        >
          {testRouteMutation.isPending ? "Probing OSRM…" : "Test OSRM route"}
        </button>
        {testRoute && (
          <button type="button" onClick={() => onTestRouteChange(null)}>
            Hide OSRM route
          </button>
        )}
      </div>
      {testRoute && (
        <div className="cluster-lab-hint">
          <strong>{testRoute.fromCode} → {testRoute.toCode}</strong> ·
          haversine {testRoute.haversineM.toFixed(0)} m ·{" "}
          {testRoute.route ? (
            <>
              OSRM <strong style={{ color: "#00c853" }}>{testRoute.route.meters.toFixed(0)} m</strong>{" "}
              ({(testRoute.route.seconds / 60).toFixed(1)} min) — see the green polyline.
            </>
          ) : (
            <strong style={{ color: "#d50000" }}>OSRM says NoRoute — these caches aren't connected on foot.</strong>
          )}
        </div>
      )}
      {testRouteMutation.error && (
        <div className="planner-error">
          {(testRouteMutation.error as Error).message}
        </div>
      )}
      {explainMutation.error && (
        <div className="planner-error">
          {(explainMutation.error as Error).message}
        </div>
      )}
      {explainMutation.data && (
        <details open className="cluster-lab-output">
          <summary>Diagnostics ({(JSON.stringify(explainMutation.data).length / 1024).toFixed(1)} kB)</summary>
          <pre>{JSON.stringify(explainMutation.data, null, 2)}</pre>
        </details>
      )}
    </div>
  );
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
