// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from "react";
import {
  useMutation,
  useQuery,
} from "@tanstack/react-query";
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
  PARKING_ACCESS_CHIPS,
  PARKING_FEE_FILTER,
  type ParkingAccessChip,
  type ParkingFeeFilter,
} from "@gctp/shared/parking-facilities";
import {
  explainSelection,
  fetchParkingOptions,
  listLanduseProfiles,
  purgeBogusWalkingCells,
  testOsrmRoute,
} from "../../lib/api.js";
import { planToGpxRoute, planToGpxTrack } from "../../lib/gpx-export.js";
import { downloadText } from "../../lib/download-text.js";
import {
  type LegPicks,
  planSignature,
  resolvePick,
} from "../../lib/persistent-state.js";
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
   * FR-SF7: extra minutes added per cache that needs equipment
   * (climbing gear, scuba, fishing rod, …). Default 5 min covers
   * "unpack equipment, get to the right spot." Range 0-60.
   */
  toolBonusMinutes: number;
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
  /**
   * How many ranked candidate clusters to ask the planner for. Default 5.
   * Larger area + sparser caches → bump it to surface lower-scoring
   * alternatives the planner would otherwise hide.
   */
  topNClusters: number;
  /**
   * Post-leg-pick fringe-trim tolerance (m). Drives the Pass-2 trim
   * that runs *after* the loop-aware leg picker has tried OSRM
   * alternatives — caches whose actual in+out walking exceeds the
   * skip-them route by more than this get dropped. Smaller = more
   * aggressive fringe cleanup; larger = more permissive.
   */
  fringeTrimMeters: number;
  /**
   * Saved landuse-weighted scoring profile (M5-β). `undefined` ⇒ no
   * landuse term in the cluster score. Resolved server-side against
   * `GET /landuse-profiles` (system + own profiles visible to the user).
   */
  landuseProfileId: string | undefined;
  /**
   * Multiplier on the cluster's `landuseMatch` term (0..5, default 1).
   * `parkingPresence` and `budgetFit` are both 0..1, so a weight of 1
   * gives landuse a roughly equal voice; bump to 3-5 when profile match
   * should dominate the ranking.
   */
  landuseWeight: number;
  /**
   * OSM-parking access chips (ADR-0011). Applied to both the planner
   * request when `startPreference === "osm-parking"` and to the
   * `OsmParkingLayer` query so the rendered icons match the planner's
   * candidate set.
   */
  osmParkingAccessFilter: readonly ParkingAccessChip[];
  /** OSM-parking fee preference. `"any"` = no preference. */
  osmParkingFeeFilter: ParkingFeeFilter;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  distanceBudgetMeters: 8_000,
  maxCaches: 15,
  minClusterSize: 8,
  maxLinkMeters: 1_500,
  startPreference: "parking-waypoint",
  timePerCacheMinutes: 5,
  toolBonusMinutes: 5,
  avgWalkingKmh: 5,
  clusteringStrategy: "louvain",
  topNClusters: 5,
  fringeTrimMeters: 500,
  landuseProfileId: undefined,
  landuseWeight: 1,
  // `permit` is opt-in per ADR-0011 — a permit-only lot you don't have a
  // permit for is functionally private.
  osmParkingAccessFilter: ["yes", "customers"],
  osmParkingFeeFilter: "any",
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
  // ── Manual plan-edit mode (FR-E2..E5) ───────────────────────────────
  /** True when the user is editing per-leg geometry; map shows hit layer. */
  editMode: boolean;
  onEditModeChange: (next: boolean) => void;
  /** Leg the panel is currently editing (matches TourLayer's highlight). */
  selectedLegIndex: number | null;
  onSelectedLegChange: (next: number | null) => void;
  /** Alternative being previewed on the map (dashed blue overlay). */
  previewAlternativeIndex: number | null;
  onPreviewAlternativeChange: (next: number | null) => void;
  /** legIndex → user-picked alternative or via-dragged geometry. */
  legPicks: LegPicks;
  onLegPicksChange: (next: LegPicks | ((prev: LegPicks) => LegPicks)) => void;
  /** Set to the leg currently being via-dragged on the map; null otherwise. */
  viaDragLegIndex: number | null;
  /** Begin a via-drag for `legIndex` seeded at `position` (typically the leg's midpoint). */
  onStartViaDrag: (legIndex: number, position: [number, number]) => void;
  /** Tear the via marker down. The persisted via-pick (if any) stays. */
  onCancelViaDrag: () => void;
  /**
   * When true, suppress the inline `<PlanResultPanel>` render (the
   * result panel is being rendered separately, e.g. in a "Tour" tab).
   * Default false preserves the single-pane layout.
   */
  hideResultPanel?: boolean;
  /**
   * When true, suppress the inline `<ClusterLabPanel>` render (it's
   * being rendered separately, e.g. in the Tools drawer).
   */
  hideClusterLab?: boolean;
  /**
   * When true, suppress the inline "Debug overlays" fieldset (moves
   * to the Tools drawer behind the cog icon).
   */
  hideDebugOverlays?: boolean;
  /**
   * Plan-mutation wiring lifted to App.tsx so the map FAB can trigger
   * the same plan request as the in-drawer candidate rows. PlannerSidebar
   * no longer owns the mutation — it just calls this callback and reads
   * the pending status to drive its row buttons.
   */
  onPlanCluster: (cluster: ClusterCandidate) => void;
  planPending: boolean;
  /** Cluster id currently being planned (null when idle). */
  planPendingClusterId: string | null;
  /** Last plan error to surface inline. `null` when there's no error. */
  planError: Error | null;
  /**
   * Same pattern for the discover mutation — lifted to App so the
   * "Discover clusters" map FAB can call it without needing the
   * PlannerSidebar to be mounted.
   */
  onDiscover: () => void;
  discoverPending: boolean;
  discoverError: Error | null;
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
  editMode,
  onEditModeChange,
  selectedLegIndex,
  onSelectedLegChange,
  previewAlternativeIndex,
  onPreviewAlternativeChange,
  legPicks,
  onLegPicksChange,
  viaDragLegIndex,
  onStartViaDrag,
  onCancelViaDrag,
  hideResultPanel = false,
  hideClusterLab = false,
  hideDebugOverlays = false,
  onPlanCluster,
  planPending,
  planPendingClusterId,
  planError,
  onDiscover,
  discoverPending,
  discoverError,
}: PlannerSidebarProps) {
  const landuseProfilesQuery = useQuery({
    queryKey: ["landuse-profiles"],
    queryFn: listLanduseProfiles,
    staleTime: 5 * 60_000, // profile list rarely changes mid-session
  });
  // discoverMutation lifted to App.tsx (FR-UX1 follow-up) — see
  // `onDiscover` / `discoverPending` / `discoverError` props.

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
      <h2>Find clusters</h2>
      <p className="muted">
        These settings shape which clusters are discovered. Pick a candidate
        below to open it in the Tour tab, where you set the start preference
        and plan the route.
      </p>

      <div className="field">
        <label>
          Tour length budget:{" "}
          {settings.distanceBudgetMeters.toLocaleString("en-US")} m
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
          <small className="muted">
            Roughly how far you want to walk in one loop.
          </small>
        </label>
        <label>
          Max caches in a loop: {settings.maxCaches}
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
      </div>

      <fieldset className="field">
        <legend>Landuse preference</legend>
        <label className="select">
          <select
            value={settings.landuseProfileId ?? ""}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                landuseProfileId:
                  e.target.value === "" ? undefined : e.target.value,
              })
            }
          >
            <option value="">(no preference)</option>
            {(landuseProfilesQuery.data?.profiles ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.ownerId === null ? "" : " (mine)"}
              </option>
            ))}
          </select>
        </label>
        {settings.landuseProfileId &&
          landuseProfilesQuery.data?.profiles.find(
            (p) => p.id === settings.landuseProfileId,
          ) && (
            <p className="muted" style={{ marginTop: 4 }}>
              {
                landuseProfilesQuery.data.profiles.find(
                  (p) => p.id === settings.landuseProfileId,
                )?.description
              }
            </p>
          )}
        <label>
          Landuse weight: {settings.landuseWeight.toFixed(1)}
          <input
            type="range"
            min={0}
            max={5}
            step={0.5}
            value={settings.landuseWeight}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                landuseWeight: Number(e.target.value),
              })
            }
          />
        </label>
      </fieldset>

      <details className="advanced">
        <summary>Advanced cluster settings</summary>
        <div className="field">
          <label>
            Min caches per cluster: {settings.minClusterSize}
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
            Clusters to show: {settings.topNClusters}
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={settings.topNClusters}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  topNClusters: Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Max gap between caches:{" "}
            {settings.maxLinkMeters.toLocaleString("en-US")} m
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
            <small className="muted">
              Caches farther apart than this on foot aren&rsquo;t linked into the
              same loop.
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
                checked={settings.clusteringStrategy === val}
                onChange={() =>
                  onSettingsChange({ ...settings, clusteringStrategy: val })
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
      </details>

      {!hideDebugOverlays && (
        <DebugOverlaysPanel
          search={search}
          settings={settings}
          showWalkingGraph={showWalkingGraph}
          onShowWalkingGraphChange={onShowWalkingGraphChange}
          walkingGraphStats={walkingGraphStats}
        />
      )}

      <div className="planner-actions">
        <button
          type="button"
          onClick={onDiscover}
          disabled={discoverPending}
        >
          {discoverPending ? "Searching…" : "Discover clusters"}
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

      {discoverError && (
        <div className="planner-error">{discoverError.message}</div>
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
            {clusters.map((c, i) => {
              // Humanised summary: estimated loop length (fall back to MST×2
              // when the estimate is absent) + a rough total time = walking at
              // the user's avg speed + visit time per cache.
              const loopKm =
                (c.estimatedTourMeters > 0
                  ? c.estimatedTourMeters
                  : c.mstLengthMeters * 2) / 1000;
              const totalMin =
                (settings.avgWalkingKmh > 0
                  ? (loopKm / settings.avgWalkingKmh) * 60
                  : 0) +
                settings.timePerCacheMinutes * c.cacheIds.length;
              return (
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
                // Hover/focus previews; double-click commits to the Tour tab
                // (same as the "Open in Tour" button).
                onDoubleClick={() => onPlanCluster(c)}
                tabIndex={0}
                title="Double-click to plan this cluster in the Tour tab"
              >
                <div className="cluster-head">
                  <span className="cluster-rank">#{i + 1}</span>
                  <strong className="cluster-caches">
                    {c.cacheIds.length} caches
                  </strong>
                  <span className="cluster-summary">
                    ~{loopKm.toFixed(1)} km loop · ~{minutes(totalMin)}
                  </span>
                </div>
                <details className="cluster-metrics">
                  <summary>details</summary>
                  <div className="cluster-breakdown">
                    <span className="chip">
                      MST {(c.mstLengthMeters / 1000).toFixed(2)} km
                    </span>
                    {c.estimatedTourMeters > 0 && (
                      <span
                        className="chip"
                        title="NN+2-opt × 1.4 haversine→walking; Pass-2 produces the real OSRM-routed value."
                      >
                        est. {(c.estimatedTourMeters / 1000).toFixed(1)} km
                      </span>
                    )}
                    <span className="chip">score {c.score.toFixed(3)}</span>
                    {Object.entries(c.scoreBreakdown).map(([k, v]) => (
                      <span key={k} className="chip">
                        {k}: {v.toFixed(2)}
                      </span>
                    ))}
                  </div>
                </details>
                <div className="cluster-row-actions">
                  <button
                    type="button"
                    onClick={() => onPlanCluster(c)}
                    disabled={planPending}
                  >
                    {planPending && c.clusterId === planPendingClusterId
                      ? "Planning…"
                      : "Open in Tour ▸"}
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
              );
            })}
          </ol>
        </div>
      )}

      {!hideClusterLab && (
        <ClusterLabPanel
          search={search}
          settings={settings}
          selectedCacheIds={selectedCacheIds}
          onSelectionChange={onSelectionChange}
          testRoute={testRoute}
          onTestRouteChange={onTestRouteChange}
        />
      )}


      {planError && (
        <div className="planner-error">{planError.message}</div>
      )}

      {result && !hideResultPanel && (
        <PlanResultPanel
          result={result}
          avgWalkingKmh={settings.avgWalkingKmh}
          caches={caches}
          editMode={editMode}
          onEditModeChange={onEditModeChange}
          selectedLegIndex={selectedLegIndex}
          onSelectedLegChange={onSelectedLegChange}
          previewAlternativeIndex={previewAlternativeIndex}
          onPreviewAlternativeChange={onPreviewAlternativeChange}
          legPicks={legPicks}
          onLegPicksChange={onLegPicksChange}
          viaDragLegIndex={viaDragLegIndex}
          onStartViaDrag={onStartViaDrag}
          onCancelViaDrag={onCancelViaDrag}
        />
      )}
    </aside>
  );
}

export function PlanResultPanel({
  result,
  avgWalkingKmh,
  caches,
  editMode,
  onEditModeChange,
  selectedLegIndex,
  onSelectedLegChange,
  previewAlternativeIndex,
  onPreviewAlternativeChange,
  legPicks,
  onLegPicksChange,
  viaDragLegIndex,
  onStartViaDrag,
  onCancelViaDrag,
}: {
  result: PlanResult;
  avgWalkingKmh: number;
  caches: readonly CacheDTO[] | undefined;
  editMode: boolean;
  onEditModeChange: (next: boolean) => void;
  selectedLegIndex: number | null;
  onSelectedLegChange: (next: number | null) => void;
  previewAlternativeIndex: number | null;
  onPreviewAlternativeChange: (next: number | null) => void;
  legPicks: LegPicks;
  onLegPicksChange: (next: LegPicks | ((prev: LegPicks) => LegPicks)) => void;
  viaDragLegIndex: number | null;
  onStartViaDrag: (legIndex: number, position: [number, number]) => void;
  onCancelViaDrag: () => void;
}) {
  // ── Edited totals + polyline ────────────────────────────────────────
  // When the user has picked alternative legs (alt-swap or dragged via),
  // the displayed totals and download polyline reflect the picks. With
  // no picks the values fall back to the planner's. Computed up front
  // so the same numbers feed the headline + downloads + JSON export
  // below. `resolvePick` handles the alt-vs-via union.
  const hasEdits = Object.keys(legPicks).length > 0;
  const editedLegMetrics = hasEdits
    ? result.legs.reduce(
        (acc, leg) => {
          const r = resolvePick(leg, legPicks[leg.index]);
          acc.meters += r.meters;
          acc.seconds += r.seconds;
          return acc;
        },
        { meters: 0, seconds: 0 },
      )
    : { meters: result.totals.meters, seconds: result.totals.seconds };
  const editedPolyline: PlanResult["polyline"] =
    hasEdits && result.legs.length > 0
      ? {
          type: "LineString",
          coordinates: result.legs.flatMap((leg, i) => {
            const r = resolvePick(leg, legPicks[leg.index]);
            const coords = r.geometry.coordinates;
            // Drop the leading coord on inner legs so the joined line
            // doesn't carry the duplicated junction vertex (same trick
            // concatLineStrings uses on the backend).
            return i === 0 ? coords : coords.slice(1);
          }),
        }
      : result.polyline;
  const km = editedLegMetrics.meters / 1000;
  // Convert distance → walking minutes at the user's pace. OSRM's own seconds
  // were profile-default (~5 km/h) — we ignore them so the user sees their
  // own pace's totals without having to re-run /tours/plan.
  const walkingMin =
    avgWalkingKmh > 0 ? (km / avgWalkingKmh) * 60 : Number.POSITIVE_INFINITY;
  const visitMin = result.totals.visitMinutes;
  const totalMin = walkingMin + visitMin;

  // Same queryKey as ParkingPreviewLayer → no double fetch. Lets us dump the
  // exact parking-options payload the map is rendering for offline diagnosis
  // of weird-looking preview routes.
  const parkingQuery = useQuery({
    queryKey: [
      "parking-options",
      [...result.orderedCacheIds].sort((a, b) => a - b),
    ],
    queryFn: () =>
      fetchParkingOptions({
        cacheIds: [...result.orderedCacheIds],
        maxOptions: 8,
      }),
    enabled: result.orderedCacheIds.length > 0,
    staleTime: 5 * 60_000,
  });

  const downloadJson = (data: unknown, slug: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `gctp-${slug}-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const downloadPlan = () => {
    // Attach the user's leg-route swaps so an offline analyser can see
    // *which* OSRM alternatives the planner picked and *which* the
    // human preferred — input for tuning the loop-aware picker. Empty
    // `legPicks` ⇒ no `manualEdits` field, keeping the JSON minimal
    // for the common "no edits" case.
    const hasManualEdits = Object.keys(legPicks).length > 0;
    if (!hasManualEdits) {
      downloadJson(result, "plan");
      return;
    }
    const editsDetail = result.legs
      .filter((leg) => legPicks[leg.index] !== undefined)
      .map((leg) => {
        const pick = legPicks[leg.index]!;
        const original = leg.alternatives[leg.selectedAlternativeIndex];
        const chosen = resolvePick(leg, pick);
        const base = {
          legIndex: leg.index,
          fromCacheId: leg.fromCacheId,
          toCacheId: leg.toCacheId,
          originalAlternativeIndex: leg.selectedAlternativeIndex,
          savedMeters: (original?.meters ?? 0) - chosen.meters,
          savedSeconds: (original?.seconds ?? 0) - chosen.seconds,
        };
        if (pick.kind === "via") {
          // Via-dragged geometry isn't one of the picker's
          // alternatives; capture the coord + the routed geometry so
          // an offline analyser can replay the OSRM request.
          return {
            ...base,
            kind: "via" as const,
            via: pick.via,
            pickedMeters: chosen.meters,
            pickedSeconds: chosen.seconds,
            geometry: chosen.geometry,
          };
        }
        return {
          ...base,
          kind: "alt" as const,
          pickedAlternativeIndex: pick.altIndex,
        };
      });
    const payload = {
      ...result,
      manualEdits: {
        planSignature: planSignature(result),
        editedTotals: editedLegMetrics,
        legPicks: editsDetail,
      },
    };
    downloadJson(payload, "plan");
  };
  const downloadParkingOptions = () => {
    if (parkingQuery.data) downloadJson(parkingQuery.data, "parking-options");
  };
  // GPX flavours — see lib/gpx-export.ts for the why of two modes.
  // Garmin file extension is .gpx regardless; the content header in
  // the file tells the device whether to treat it as a track or a
  // route.
  const downloadGpx = (mode: "track" | "route") => {
    const text =
      mode === "track"
        ? planToGpxTrack(
            result,
            caches,
            undefined,
            hasEdits ? editedPolyline : undefined,
          )
        : planToGpxRoute(result, caches);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    downloadText({
      text,
      filename: `gctp-tour-${mode}-${ts}.gpx`,
      mimeType: "application/gpx+xml",
    });
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

      {/* ── Edit mode (FR-E2..E5) ─────────────────────────────────────
          Toggling on splits the tour line into clickable per-leg
          features (in TourLayer); clicking a leg opens the
          LegAlternativesPanel below. Solver-path plans expose no
          alternatives — the UI degrades to a hint. */}
      <div className="field" style={{ marginTop: 8 }}>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={editMode}
            onChange={(e) => {
              onEditModeChange(e.target.checked);
              if (!e.target.checked) {
                onSelectedLegChange(null);
                onPreviewAlternativeChange(null);
              }
            }}
            disabled={result.legs.length === 0}
            title={
              result.legs.length === 0
                ? "This plan has no per-leg alternatives (solver path)."
                : "Click a leg on the map to swap its geometry for an OSRM alternative."
            }
          />
          Edit tour (click a leg to swap geometry)
        </label>
        {hasEdits && (
          <div className="cluster-lab-hint">
            {Object.keys(legPicks).length} leg
            {Object.keys(legPicks).length === 1 ? "" : "s"} edited.{" "}
            <button
              type="button"
              onClick={() => {
                onLegPicksChange({});
                onPreviewAlternativeChange(null);
              }}
            >
              Reset edits
            </button>
          </div>
        )}
      </div>

      {editMode && selectedLegIndex !== null && result.legs[selectedLegIndex] && (
        <LegAlternativesPanel
          leg={result.legs[selectedLegIndex]!}
          pick={legPicks[selectedLegIndex]}
          previewAlternativeIndex={previewAlternativeIndex}
          onPreviewAlternativeChange={onPreviewAlternativeChange}
          onApplyAlt={(altIndex) => {
            onLegPicksChange((prev) => ({
              ...prev,
              [selectedLegIndex]: { kind: "alt", altIndex },
            }));
            onPreviewAlternativeChange(null);
            // Switching to an alt-pick retires any active via marker
            // on the same leg — the geometries diverge.
            if (viaDragLegIndex === selectedLegIndex) onCancelViaDrag();
          }}
          onResetLeg={() => {
            onLegPicksChange((prev) => {
              const { [selectedLegIndex]: _drop, ...rest } = prev;
              return rest;
            });
            onPreviewAlternativeChange(null);
            if (viaDragLegIndex === selectedLegIndex) onCancelViaDrag();
          }}
          onClose={() => {
            onSelectedLegChange(null);
            onPreviewAlternativeChange(null);
          }}
          caches={caches}
          viaDragActive={viaDragLegIndex === selectedLegIndex}
          onStartViaDrag={() => {
            // Seed the marker at the arclength-midpoint of the
            // currently-displayed leg geometry — the user can drag
            // from there. resolvePick handles whether the user has
            // already applied an alt or a via.
            const r = resolvePick(
              result.legs[selectedLegIndex]!,
              legPicks[selectedLegIndex],
            );
            const mid = midpoint(r.geometry.coordinates);
            if (mid) onStartViaDrag(selectedLegIndex, mid);
          }}
          onCancelViaDrag={onCancelViaDrag}
        />
      )}

      <div className="planner-actions">
        <button
          type="button"
          onClick={downloadPlan}
          title="Download the planned tour (ordered cache ids + per-leg polylines + score breakdown) as JSON for offline analysis"
        >
          Download plan JSON
        </button>
        <button
          type="button"
          onClick={downloadParkingOptions}
          disabled={!parkingQuery.data || parkingQuery.data.options.length === 0}
          title="Download the parking-preview options shown on the map (per-parking walking polyline + meters/seconds) for diagnosing long preview routes"
        >
          Download parking options JSON
        </button>
        <button
          type="button"
          onClick={() => downloadGpx("track")}
          title="Download as a GPX track — the Garmin follows the exact OSRM polyline drawn on the map. Best when you trust the planner's route more than the device's onboard basemap."
        >
          Download GPX track
        </button>
        <button
          type="button"
          onClick={() => downloadGpx("route")}
          title="Download as a GPX route — the Garmin treats the parking + each cache as waypoints and computes leg geometry on-device, with auto-recompute if you stray. Best for turn-by-turn navigation."
        >
          Download GPX route
        </button>
      </div>
    </div>
  );
}

/**
 * Per-leg alternatives panel — listed under PlanResultPanel when the
 * user clicks a leg on the map in edit mode. Three ways to override
 * the leg geometry:
 *
 *   1. Pick one of the OSRM alternatives the loop-aware picker
 *      already considered (no extra OSRM cost).
 *   2. Drop a draggable via-waypoint on the map; OSRM routes the
 *      leg through it. Throttled OSRM probes during drag, persisted
 *      `{ kind: "via", … }` pick on dragend.
 *   3. Reset to the planner's pick.
 *
 * Applied picks persist by `planSignature` so reload + replan-same
 * cluster restores them; replan-different-cluster doesn't apply.
 */
function LegAlternativesPanel({
  leg,
  pick,
  previewAlternativeIndex,
  onPreviewAlternativeChange,
  onApplyAlt,
  onResetLeg,
  onClose,
  caches,
  viaDragActive,
  onStartViaDrag,
  onCancelViaDrag,
}: {
  leg: NonNullable<PlanResult["legs"][number]>;
  /** Currently-applied pick (undefined = planner pick). */
  pick: LegPicks[number] | undefined;
  previewAlternativeIndex: number | null;
  onPreviewAlternativeChange: (next: number | null) => void;
  onApplyAlt: (altIndex: number) => void;
  onResetLeg: () => void;
  onClose: () => void;
  caches: readonly CacheDTO[] | undefined;
  /** True while this leg is the one being via-dragged on the map. */
  viaDragActive: boolean;
  onStartViaDrag: () => void;
  onCancelViaDrag: () => void;
}) {
  const cacheById = new Map<number, CacheDTO>();
  for (const c of caches ?? []) cacheById.set(c.id, c);
  const label = (id: number): string => {
    if (id === 0) return "Parking";
    const c = cacheById.get(id);
    return c ? c.code : `cache-${id}`;
  };

  const isViaPick = pick?.kind === "via";
  const pickedAltIndex =
    pick?.kind === "alt" ? pick.altIndex : leg.selectedAlternativeIndex;
  const hasOverride =
    isViaPick || pickedAltIndex !== leg.selectedAlternativeIndex;
  const sortedAlts = leg.alternatives
    .map((alt, idx) => ({ alt, idx }))
    .sort((a, b) => a.alt.meters - b.alt.meters);

  return (
    <div className="plan-leg-panel">
      <h4>
        Leg #{leg.index + 1}: {label(leg.fromCacheId)} → {label(leg.toCacheId)}
      </h4>
      {isViaPick && pick && (
        <div className="cluster-lab-hint">
          Via-routed through ({pick.via[1].toFixed(5)},{" "}
          {pick.via[0].toFixed(5)}) — {(pick.meters / 1000).toFixed(2)} km,{" "}
          {Math.round(pick.seconds / 60)} min.
        </div>
      )}
      {leg.alternatives.length <= 1 ? (
        <p className="muted">
          Only one OSRM alternative for this leg — pick a via-point instead.
        </p>
      ) : (
        <ul className="leg-alternatives">
          {sortedAlts.map(({ alt, idx }) => {
            const isPicked = !isViaPick && idx === pickedAltIndex;
            const isOriginal = idx === leg.selectedAlternativeIndex;
            const isPreview = idx === previewAlternativeIndex;
            return (
              <li
                key={idx}
                className={[
                  "leg-alt",
                  isPicked ? "picked" : "",
                  isPreview ? "previewing" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => onPreviewAlternativeChange(idx)}
                onMouseLeave={() => {
                  if (previewAlternativeIndex === idx)
                    onPreviewAlternativeChange(null);
                }}
                onFocus={() => onPreviewAlternativeChange(idx)}
                tabIndex={0}
              >
                <div className="leg-alt-head">
                  <strong>{(alt.meters / 1000).toFixed(2)} km</strong>{" "}
                  <small>({Math.round(alt.seconds / 60)} min)</small>
                  {isOriginal && (
                    <span className="chip" title="OSRM-picker chose this">
                      planner
                    </span>
                  )}
                  {isPicked && !isOriginal && (
                    <span className="chip" title="Your override">
                      applied
                    </span>
                  )}
                </div>
                <div className="leg-alt-actions">
                  <button
                    type="button"
                    disabled={isPicked}
                    onClick={() => onApplyAlt(idx)}
                  >
                    {isPicked ? "Applied" : "Apply"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="planner-actions">
        {viaDragActive ? (
          <button
            type="button"
            onClick={onCancelViaDrag}
            title="Hide the draggable via-point marker. The current via-pick (if applied) stays in effect."
          >
            Hide via-point
          </button>
        ) : (
          <button
            type="button"
            onClick={onStartViaDrag}
            title="Drop a draggable waypoint on the leg's midpoint. Drag it around the map and watch OSRM reroute the leg live; release to commit."
          >
            {isViaPick ? "Re-grab via-point" : "Add via-point"}
          </button>
        )}
        {hasOverride && (
          <button type="button" onClick={onResetLeg}>
            Reset this leg
          </button>
        )}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * Approximate the midpoint of a polyline by arclength — the point at
 * half the total length. Used to seed the via-marker so the user starts
 * with the marker on the leg and drags from there.
 */
function midpoint(
  coords: ReadonlyArray<readonly [number, number]>,
): [number, number] | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) return [coords[0]![0], coords[0]![1]];
  let total = 0;
  const segLens: number[] = [];
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    // Equirectangular m/deg — fine for short legs. Same approximation
    // the planner uses internally.
    const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
    const dy = b[1] - a[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    segLens.push(d);
    total += d;
  }
  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < segLens.length; i += 1) {
    const next = acc + segLens[i]!;
    if (next >= half) {
      const t = segLens[i]! > 0 ? (half - acc) / segLens[i]! : 0;
      const a = coords[i]!;
      const b = coords[i + 1]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    acc = next;
  }
  const last = coords[coords.length - 1]!;
  return [last[0], last[1]];
}

function minutes(m: number): string {
  if (!Number.isFinite(m) || m < 0) return "—";
  const h = Math.floor(m / 60);
  const mm = Math.round(m - h * 60);
  if (h === 0) return `${mm} min`;
  return `${h} h ${mm.toString().padStart(2, "0")} min`;
}

/**
 * Walking-graph debug overlay + suspicious-edge purge button (FR-UX1
 * moved this out of the Plan tab into the Tools drawer). Owns the
 * `purgeBogus` mutation locally so the move was a pure cut-and-paste
 * without lifting state.
 */
export interface DebugOverlaysPanelProps {
  search: SearchParams;
  settings: PlanSettings;
  showWalkingGraph: boolean;
  onShowWalkingGraphChange: (next: boolean) => void;
  walkingGraphStats: WalkingGraphResponse["stats"] | null;
}

export function DebugOverlaysPanel({
  search,
  settings,
  showWalkingGraph,
  onShowWalkingGraphChange,
  walkingGraphStats,
}: DebugOverlaysPanelProps): JSX.Element {
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
      void queryClient.invalidateQueries({ queryKey: ["walking-graph"] });
    },
  });
  return (
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
  );
}

/**
 * FR-UX1: Tour-tab settings — controls that affect the planned-route
 * shape, not which clusters get discovered. Fringe trim, per-cache
 * visit time, tool-cache bonus, walking speed, and the start
 * preference (incl. OSM-parking filters when relevant) live here so
 * the user can tweak them without re-doing cluster discovery.
 */
export interface TourSettingsPanelProps {
  settings: PlanSettings;
  onSettingsChange: (next: PlanSettings) => void;
}

export function TourSettingsPanel({
  settings,
  onSettingsChange,
}: TourSettingsPanelProps): JSX.Element {
  return (
    <aside className="sidebar planner-sidebar">
      <h2>Tour settings</h2>

      <div className="field">
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
          Extra time for tool caches (min): {settings.toolBonusMinutes}
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={settings.toolBonusMinutes}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                toolBonusMinutes: Number(e.target.value),
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
        <legend>Start preference</legend>
        {(
          [
            ["parking-waypoint", "Cache-owner parking (PQ)"],
            ["osrm-nearest-road", "Nearest car-accessible road"],
            ["user-supplied-point", "Use current search center"],
            ["osm-parking", "OSM amenity=parking (ADR-0011)"],
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
        {settings.startPreference === "osm-parking" && (
          <div className="osm-parking-filters" style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 6 }}>
              <span className="muted" style={{ marginRight: 8 }}>
                Access
              </span>
              {PARKING_ACCESS_CHIPS.map((chip) => {
                const on = settings.osmParkingAccessFilter.includes(chip);
                return (
                  <label
                    key={chip}
                    className="checkbox"
                    style={{ display: "inline-block", marginRight: 6 }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const next = on
                          ? settings.osmParkingAccessFilter.filter(
                              (c) => c !== chip,
                            )
                          : [...settings.osmParkingAccessFilter, chip];
                        onSettingsChange({
                          ...settings,
                          osmParkingAccessFilter: next,
                        });
                      }}
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
                    checked={settings.osmParkingFeeFilter === opt}
                    onChange={() =>
                      onSettingsChange({
                        ...settings,
                        osmParkingFeeFilter: opt,
                      })
                    }
                  />
                  {opt}
                </label>
              ))}
            </div>
          </div>
        )}
      </fieldset>

      <details className="advanced">
        <summary>Advanced tour settings</summary>
        <div className="field">
          <label>
            Trim out-and-back spurs: {settings.fringeTrimMeters} m
            <input
              type="range"
              min={100}
              max={3000}
              step={50}
              value={settings.fringeTrimMeters}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  fringeTrimMeters: Number(e.target.value),
                })
              }
            />
            <small className="muted">
              Drop a cache whose in-and-out path retraces more than this much of
              itself (a dead-end spur).
            </small>
          </label>
        </div>
      </details>
    </aside>
  );
}

export interface ClusterLabPanelProps {
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
export function ClusterLabPanel({
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
      return "Nearest road";
    case "user":
      return "User-supplied point";
    case "osm":
      return "OSM amenity=parking";
  }
}
