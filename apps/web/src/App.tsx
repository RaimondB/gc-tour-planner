// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useMemo, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { useQuery } from "@tanstack/react-query";
import type {
  ClusterCandidate,
  ClusterDiagnostics,
  PlanResult,
} from "@gctp/shared/tours";
import { listCaches } from "./lib/api.js";
import {
  type LegPicks,
  planSignature,
  useLocalStorageState,
} from "./lib/persistent-state.js";
import { DEFAULT_SEARCH, type SearchParams } from "./lib/search-params.js";
import { MapView } from "./features/map/MapView.js";
import { CachesLayer, type SelectedParking } from "./features/map/CachesLayer.js";
import { ClustersPreviewLayer } from "./features/map/ClustersPreviewLayer.js";
import { LanduseLayer } from "./features/map/LanduseLayer.js";
import { LegAlternativePreviewLayer } from "./features/map/LegAlternativePreviewLayer.js";
import {
  LegViaPointLayer,
  type ViaDragState,
} from "./features/map/LegViaPointLayer.js";
import { ZoomDebugBadge } from "./features/map/ZoomDebugBadge.js";
import { OsmParkingLayer } from "./features/map/OsmParkingLayer.js";
import { ParkingOwnerLinkLayer } from "./features/map/ParkingOwnerLinkLayer.js";
import { ParkingPreviewLayer } from "./features/map/ParkingPreviewLayer.js";
import { RadiusLayer } from "./features/map/RadiusLayer.js";
import { TourLayer } from "./features/map/TourLayer.js";
import { WalkingGraphLayer } from "./features/map/WalkingGraphLayer.js";
import { TestRouteLayer } from "./features/map/TestRouteLayer.js";
import type {
  TestRouteResponse,
  WalkingGraphResponse,
} from "@gctp/shared/tours";
import { FilterSidebar } from "./features/search/FilterSidebar.js";
import {
  DEFAULT_PLAN_SETTINGS,
  PlannerSidebar,
  PlanResultPanel,
  type PlanSettings,
} from "./features/planning/PlannerSidebar.js";
import { AdminPrecomputePanel } from "./features/admin/AdminPrecomputePanel.js";
import { UploadDropzone } from "./features/upload/UploadDropzone.js";

/**
 * Sidebar tab id (FR-UX1). Workflow stages map 1:1 — Filter sets up
 * what's on the map, Plan asks for clusters + plans a loop, Tour
 * holds the planned tour's totals + edit/exports.
 */
type SidebarTab = "filter" | "plan" | "tour";

export default function App(): JSX.Element {
  const [params, setParams] = useLocalStorageState<SearchParams>(
    "search",
    DEFAULT_SEARCH,
  );
  const [planSettings, setPlanSettings] = useLocalStorageState<PlanSettings>(
    "plan-settings",
    DEFAULT_PLAN_SETTINGS,
  );
  // Persisted map viewport — restored on first mount of MapView, refreshed
  // on every `moveend`. Decoupled from `params.center` so panning around to
  // browse parking doesn't churn the search.
  const [viewport, setViewport] = useLocalStorageState<{
    center: [number, number];
    zoom: number;
  } | null>("viewport", null);
  const [clusters, setClusters] = useState<ClusterCandidate[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<ClusterDiagnostics | null>(
    null,
  );
  const [chosenClusterId, setChosenClusterId] = useState<string | null>(null);
  const [focusedClusterId, setFocusedClusterId] = useState<string | null>(null);
  /**
   * Most recently clicked parking spot — drives the yellow dotted line to
   * the cache that listed it. Set from either a parking-marker click in
   * `CachesLayer` or a dashed-line click in `ParkingPreviewLayer`.
   */
  const [selectedParking, setSelectedParking] =
    useState<SelectedParking | null>(null);
  const [planResult, setPlanResultRaw] = useState<PlanResult | null>(null);
  /**
   * Manual cluster selection — populated by shift-clicking cache markers on the
   * map (or by "Use as selection" on a candidate row). Drives the Cluster Lab
   * `/tours/clusters/explain` workflow.
   */
  const [selectedCacheIds, setSelectedCacheIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  /** Toggleable debug overlay — the actual OSRM walking edges the planner sees. */
  const [showWalkingGraph, setShowWalkingGraph] = useState(false);
  const [walkingGraphStats, setWalkingGraphStats] = useState<
    WalkingGraphResponse["stats"] | null
  >(null);
  /** Last OSRM /route probe result, rendered as a bright-green polyline. */
  const [testRoute, setTestRoute] = useState<TestRouteResponse | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  // ── Manual plan-edit state (FR-E2..E6) ──────────────────────────────
  // Edit-mode toggle persists in localStorage with the other plan
  // settings; the rest of the edit state is scoped to the current
  // planResult and resets whenever a different planSignature lands.
  const [editMode, setEditMode] = useLocalStorageState<boolean>(
    "edit-mode",
    false,
  );
  // ── Sidebar UX (FR-UX1) ─────────────────────────────────────────────
  // Tab the user is currently looking at. Persisted in localStorage so
  // a page reload doesn't bounce them back to Filter while they're
  // mid-edit of a planned tour. Tools drawer is ephemeral (debug-y, no
  // need to restore).
  const [activeTab, setActiveTab] = useLocalStorageState<SidebarTab>(
    "ui:active-tab",
    "filter",
  );
  const [toolsOpen, setToolsOpen] = useState(false);
  const [selectedLegIndex, setSelectedLegIndex] = useState<number | null>(null);
  const [previewAlternativeIndex, setPreviewAlternativeIndex] = useState<
    number | null
  >(null);
  // Live-drag via-point state. Non-null while the user is positioning /
  // dragging a via marker; cleared when the marker is closed or a new
  // plan arrives.
  const [viaDrag, setViaDrag] = useState<ViaDragState | null>(null);
  // Per-plan picks: { [legIndex]: alternativeIndex }. Keyed in localStorage
  // by the plan signature so re-planning the same cluster restores the
  // user's picks and re-planning a different cluster doesn't apply them.
  const currentPlanSignature = planResult ? planSignature(planResult) : null;
  const [legPicks, setLegPicks] = useLocalStorageState<LegPicks>(
    currentPlanSignature
      ? `plan-edits:${currentPlanSignature}`
      : "plan-edits:none",
    {},
  );

  // Clear the focused cluster whenever the real OSRM-routed result lands —
  // the TourLayer takes over and we don't want two polylines fighting on the map.
  // Also clear the ephemeral edit-selection state: the picks themselves
  // persist in localStorage keyed by planSignature (so re-planning the
  // same cluster restores them), but the panel's current "which leg are
  // you editing right now" must reset on a new plan.
  const setPlanResult = useCallback((next: PlanResult | null) => {
    setPlanResultRaw(next);
    if (next) setFocusedClusterId(null);
    setSelectedLegIndex(null);
    setPreviewAlternativeIndex(null);
    setViaDrag(null);
  }, []);

  /**
   * Called from `LegAlternativesPanel`'s "Add via-point" button. Computes
   * a sensible initial position (midpoint of the currently-displayed leg
   * geometry) and seeds the drag state — the layer kicks off an OSRM
   * probe immediately so a preview appears before the user even touches
   * the marker.
   */
  const startViaDrag = useCallback(
    (legIndex: number, position: [number, number]) => {
      const leg = planResult?.legs[legIndex];
      if (!leg) return;
      setViaDrag({
        legIndex,
        fromCacheId: leg.fromCacheId,
        toCacheId: leg.toCacheId,
        position,
        live: null,
        status: "loading",
      });
    },
    [planResult],
  );

  const cancelViaDrag = useCallback(() => setViaDrag(null), []);

  // Mirror query at App level so the sidebar can show the count without
  // CachesLayer having to lift it up. Same queryKey → same cache entry, no
  // double fetch.
  // Source the cluster's cache IDs for the parking-preview layer:
  //   * planned tour → its `orderedCacheIds` (the cluster the user committed to)
  //   * else the focused cluster from the candidate list (preview-on-hover)
  //   * else empty (preview hidden)
  const parkingPreviewCacheIds = useMemo<readonly number[]>(() => {
    if (planResult) return planResult.orderedCacheIds;
    if (focusedClusterId && clusters) {
      const focused = clusters.find((c) => c.clusterId === focusedClusterId);
      if (focused) return focused.cacheIds;
    }
    return [];
  }, [planResult, focusedClusterId, clusters]);

  const cachesQuery = useQuery({
    queryKey: ["caches", params],
    queryFn: () =>
      listCaches({
        center: params.center,
        radiusM: params.radiusM,
        types: params.types.length > 0 ? params.types : undefined,
        excludeFound: params.excludeFound || undefined,
        contexts: params.contexts.length > 0 ? params.contexts : undefined,
        includeDisabled: params.includeDisabled || undefined,
      }),
    placeholderData: (prev) => prev,
  });

  const handleParamsChange = useCallback(
    (next: SearchParams, opts?: { fly?: boolean }) => {
      setParams(next);
      if (opts?.fly && mapRef.current) {
        mapRef.current.flyTo({
          center: next.center,
          zoom: zoomForRadius(next.radiusM),
          essential: true,
        });
      }
    },
    [],
  );

  const handlePickCenter = useCallback((lngLat: [number, number]) => {
    setParams((prev) => ({ ...prev, center: lngLat }));
  }, []);

  // ── Tab state derivations (FR-UX1) ─────────────────────────────────
  // Plan tab is meaningful as soon as the user has at least one cache
  // in the search; Tour tab only once a plan has been built. Until
  // those conditions are met the tabs render as visibly-disabled so
  // the workflow stages stay discoverable without being clickable.
  const caches = cachesQuery.data?.caches;
  const planTabEnabled = (caches?.length ?? 0) > 0;
  const tourTabEnabled = planResult !== null;
  const handleTabClick = useCallback(
    (tab: SidebarTab) => {
      if (tab === "plan" && !planTabEnabled) return;
      if (tab === "tour" && !tourTabEnabled) return;
      setActiveTab(tab);
    },
    [planTabEnabled, tourTabEnabled, setActiveTab],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__title">
          <h1>gc-tour-planner</h1>
          <p>Plan closed-loop geocaching tours from filtered cache clusters.</p>
        </div>
        <button
          type="button"
          className="app-header__tools"
          onClick={() => setToolsOpen((v) => !v)}
          aria-expanded={toolsOpen}
          aria-controls="tools-drawer"
          title="Developer tools (cluster lab, debug overlays, admin)"
        >
          ⚙ Tools
        </button>
      </header>

      <div className="app-body">
        <div className="left-pane">
          <nav className="sidebar-tabs" role="tablist" aria-label="Sidebar sections">
            <TabButton
              id="filter"
              label="Filter"
              active={activeTab === "filter"}
              enabled
              onClick={handleTabClick}
            />
            <TabButton
              id="plan"
              label="Plan"
              active={activeTab === "plan"}
              enabled={planTabEnabled}
              disabledHint="Upload a GPX or widen the search to see caches first."
              onClick={handleTabClick}
            />
            <TabButton
              id="tour"
              label="Tour"
              active={activeTab === "tour"}
              enabled={tourTabEnabled}
              disabledHint="Plan a loop in the Plan tab first."
              onClick={handleTabClick}
            />
          </nav>

          <div
            className="sidebar-tabpanel"
            role="tabpanel"
            aria-labelledby={`tab-${activeTab}`}
          >
            {activeTab === "filter" && (
              <>
                <UploadDropzone />
                <AdminPrecomputePanel />
                <FilterSidebar
                  value={params}
                  onChange={handleParamsChange}
                  cacheCount={caches?.length}
                  loading={cachesQuery.isFetching}
                />
              </>
            )}
            {activeTab === "plan" && (
              <PlannerSidebar
                search={params}
                settings={planSettings}
                onSettingsChange={setPlanSettings}
                clusters={clusters}
                onClustersChange={setClusters}
                diagnostics={diagnostics}
                onDiagnosticsChange={setDiagnostics}
                chosenClusterId={chosenClusterId}
                onChosenClusterChange={setChosenClusterId}
                focusedClusterId={focusedClusterId}
                onFocusClusterChange={setFocusedClusterId}
                result={planResult}
                onResultChange={setPlanResult}
                caches={caches}
                selectedCacheIds={selectedCacheIds}
                onSelectionChange={setSelectedCacheIds}
                showWalkingGraph={showWalkingGraph}
                onShowWalkingGraphChange={setShowWalkingGraph}
                walkingGraphStats={walkingGraphStats}
                testRoute={testRoute}
                onTestRouteChange={setTestRoute}
                editMode={editMode}
                onEditModeChange={setEditMode}
                selectedLegIndex={selectedLegIndex}
                onSelectedLegChange={setSelectedLegIndex}
                previewAlternativeIndex={previewAlternativeIndex}
                onPreviewAlternativeChange={setPreviewAlternativeIndex}
                legPicks={legPicks}
                onLegPicksChange={setLegPicks}
                viaDragLegIndex={viaDrag?.legIndex ?? null}
                onStartViaDrag={startViaDrag}
                onCancelViaDrag={cancelViaDrag}
                hideResultPanel
              />
            )}
            {activeTab === "tour" &&
              (planResult ? (
                <PlanResultPanel
                  result={planResult}
                  avgWalkingKmh={planSettings.avgWalkingKmh}
                  caches={caches}
                  editMode={editMode}
                  onEditModeChange={setEditMode}
                  selectedLegIndex={selectedLegIndex}
                  onSelectedLegChange={setSelectedLegIndex}
                  previewAlternativeIndex={previewAlternativeIndex}
                  onPreviewAlternativeChange={setPreviewAlternativeIndex}
                  legPicks={legPicks}
                  onLegPicksChange={setLegPicks}
                  viaDragLegIndex={viaDrag?.legIndex ?? null}
                  onStartViaDrag={startViaDrag}
                  onCancelViaDrag={cancelViaDrag}
                />
              ) : (
                <p className="muted">No planned tour yet — head to the Plan tab.</p>
              ))}
          </div>
        </div>
        <main className="app-main">
          <MapView
            initialCenter={viewport?.center ?? params.center}
            initialZoom={viewport?.zoom ?? zoomForRadius(params.radiusM)}
            onPickCenter={handlePickCenter}
            onReady={(m) => {
              mapRef.current = m;
            }}
            onViewportChange={setViewport}
          >
            <LanduseLayer params={params} />
            <OsmParkingLayer
              access={planSettings.osmParkingAccessFilter}
              fee={planSettings.osmParkingFeeFilter}
            />
            <RadiusLayer params={params} />
            <CachesLayer
              params={params}
              selectedCacheIds={selectedCacheIds}
              onSelectionChange={setSelectedCacheIds}
              onParkingSelect={setSelectedParking}
            />
            <ClustersPreviewLayer
              candidates={clusters}
              caches={cachesQuery.data?.caches}
              focusedClusterId={focusedClusterId}
              onCentroidClick={setFocusedClusterId}
            />
            <TourLayer
              result={planResult}
              caches={cachesQuery.data?.caches}
              editMode={editMode}
              legPicks={legPicks}
              selectedLegIndex={selectedLegIndex}
              onLegSelect={setSelectedLegIndex}
            />
            <LegAlternativePreviewLayer
              result={planResult}
              selectedLegIndex={selectedLegIndex}
              previewAlternativeIndex={previewAlternativeIndex}
            />
            <LegViaPointLayer
              state={viaDrag}
              onPositionChange={(pos) =>
                setViaDrag((v) => (v ? { ...v, position: pos } : v))
              }
              onLiveChange={(live) =>
                setViaDrag((v) => (v ? { ...v, live } : v))
              }
              onStatusChange={(status) =>
                setViaDrag((v) => (v ? { ...v, status } : v))
              }
              onCommit={(final, position) => {
                setViaDrag((v) => {
                  if (!v) return v;
                  // Persist the via geometry in legPicks keyed by leg
                  // index so the TourLayer rebuild + GPX/JSON exports
                  // all pick it up. Keep the drag state alive so the
                  // user can immediately refine the marker.
                  setLegPicks((prev) => ({
                    ...prev,
                    [v.legIndex]: {
                      kind: "via",
                      via: position,
                      meters: final.meters,
                      seconds: final.seconds,
                      geometry: final.geometry,
                    },
                  }));
                  return { ...v, position, live: final, status: "ok" };
                });
              }}
            />
            <ParkingPreviewLayer
              cacheIds={parkingPreviewCacheIds}
              maxWalkingMeters={planSettings.maxLinkMeters}
              onParkingSelect={setSelectedParking}
            />
            <ParkingOwnerLinkLayer
              selectedParking={selectedParking}
              caches={cachesQuery.data?.caches}
            />
            <WalkingGraphLayer
              enabled={showWalkingGraph}
              params={params}
              maxLinkMeters={planSettings.maxLinkMeters}
              distanceBudgetMeters={planSettings.distanceBudgetMeters}
              onStatsChange={setWalkingGraphStats}
            />
            <TestRouteLayer result={testRoute} />
            <ZoomDebugBadge />
          </MapView>
        </main>
      </div>

      {toolsOpen && (
        <div
          className="tools-drawer-backdrop"
          onClick={() => setToolsOpen(false)}
          role="presentation"
        >
          <aside
            id="tools-drawer"
            className="tools-drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Developer tools"
          >
            <header className="tools-drawer__header">
              <h2>Tools</h2>
              <button
                type="button"
                onClick={() => setToolsOpen(false)}
                aria-label="Close tools drawer"
              >
                ✕
              </button>
            </header>
            <p className="muted" style={{ padding: "0 1rem" }}>
              Cluster Lab, debug overlays, and admin panels move in here in the
              next iteration. Currently they still live in the Filter/Plan tabs.
            </p>
          </aside>
        </div>
      )}

      <footer className="app-footer">
        Map data &copy;{" "}
        <a href="https://www.openstreetmap.org/copyright">
          OpenStreetMap contributors
        </a>
      </footer>
    </div>
  );
}

/**
 * Minimal tab-bar button (FR-UX1). Disabled state is greyed +
 * unclickable but keeps the tab visible so the workflow stages stay
 * discoverable. Tooltip on disabled tabs nudges the user toward the
 * action that unlocks it (e.g. "upload a GPX first").
 */
function TabButton({
  id,
  label,
  active,
  enabled,
  disabledHint,
  onClick,
}: {
  id: SidebarTab;
  label: string;
  active: boolean;
  enabled: boolean;
  disabledHint?: string;
  onClick: (id: SidebarTab) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      id={`tab-${id}`}
      role="tab"
      aria-selected={active}
      aria-controls="sidebar-tabpanel"
      className={`sidebar-tab${active ? " sidebar-tab--active" : ""}`}
      onClick={() => onClick(id)}
      disabled={!enabled}
      title={!enabled ? disabledHint : undefined}
    >
      {label}
    </button>
  );
}

/**
 * Pick a zoom level so the search-radius circle roughly fits the viewport.
 * Empirical mapping — refine if user reports it's too tight/loose.
 */
function zoomForRadius(radiusM: number): number {
  if (radiusM <= 1_000) return 14;
  if (radiusM <= 2_500) return 13;
  if (radiusM <= 5_000) return 12;
  if (radiusM <= 10_000) return 11;
  if (radiusM <= 20_000) return 10;
  return 9;
}
