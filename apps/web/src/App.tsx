// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { useQuery } from "@tanstack/react-query";
import type {
  ClusterCandidate,
  ClusterDiagnostics,
  PlanResult,
} from "@gctp/shared/tours";
import { listCaches } from "./lib/api.js";
import { DEFAULT_SEARCH, type SearchParams } from "./lib/search-params.js";
import { MapView } from "./features/map/MapView.js";
import { CachesLayer } from "./features/map/CachesLayer.js";
import { ClustersPreviewLayer } from "./features/map/ClustersPreviewLayer.js";
import { LanduseLayer } from "./features/map/LanduseLayer.js";
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
  type PlanSettings,
} from "./features/planning/PlannerSidebar.js";
import { AdminPrecomputePanel } from "./features/admin/AdminPrecomputePanel.js";
import { UploadDropzone } from "./features/upload/UploadDropzone.js";

export default function App(): JSX.Element {
  const [params, setParams] = useState<SearchParams>(DEFAULT_SEARCH);
  const [planSettings, setPlanSettings] = useState<PlanSettings>(
    DEFAULT_PLAN_SETTINGS,
  );
  const [clusters, setClusters] = useState<ClusterCandidate[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<ClusterDiagnostics | null>(
    null,
  );
  const [chosenClusterId, setChosenClusterId] = useState<string | null>(null);
  const [focusedClusterId, setFocusedClusterId] = useState<string | null>(null);
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

  // Clear the focused cluster whenever the real OSRM-routed result lands —
  // the TourLayer takes over and we don't want two polylines fighting on the map.
  const setPlanResult = useCallback((next: PlanResult | null) => {
    setPlanResultRaw(next);
    if (next) setFocusedClusterId(null);
  }, []);

  // Mirror query at App level so the sidebar can show the count without
  // CachesLayer having to lift it up. Same queryKey → same cache entry, no
  // double fetch.
  const cachesQuery = useQuery({
    queryKey: ["caches", params],
    queryFn: () =>
      listCaches({
        center: params.center,
        radiusM: params.radiusM,
        types: params.types.length > 0 ? params.types : undefined,
        excludeFound: params.excludeFound || undefined,
        contexts: params.contexts.length > 0 ? params.contexts : undefined,
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

  return (
    <div className="app">
      <header className="app-header">
        <h1>gc-tour-planner</h1>
        <p>Plan closed-loop geocaching tours from filtered cache clusters.</p>
      </header>

      <div className="app-body">
        <div className="left-pane">
          <UploadDropzone />
          <AdminPrecomputePanel />
          <FilterSidebar
            value={params}
            onChange={handleParamsChange}
            cacheCount={cachesQuery.data?.caches.length}
            loading={cachesQuery.isFetching}
          />
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
            caches={cachesQuery.data?.caches}
            selectedCacheIds={selectedCacheIds}
            onSelectionChange={setSelectedCacheIds}
            showWalkingGraph={showWalkingGraph}
            onShowWalkingGraphChange={setShowWalkingGraph}
            walkingGraphStats={walkingGraphStats}
            testRoute={testRoute}
            onTestRouteChange={setTestRoute}
          />
        </div>
        <main className="app-main">
          <MapView
            initialCenter={params.center}
            initialZoom={zoomForRadius(params.radiusM)}
            onPickCenter={handlePickCenter}
            onReady={(m) => {
              mapRef.current = m;
            }}
          >
            <LanduseLayer params={params} />
            <RadiusLayer params={params} />
            <CachesLayer
              params={params}
              selectedCacheIds={selectedCacheIds}
              onSelectionChange={setSelectedCacheIds}
            />
            <ClustersPreviewLayer
              candidates={clusters}
              caches={cachesQuery.data?.caches}
              focusedClusterId={focusedClusterId}
              onCentroidClick={setFocusedClusterId}
            />
            <TourLayer result={planResult} caches={cachesQuery.data?.caches} />
            <WalkingGraphLayer
              enabled={showWalkingGraph}
              params={params}
              maxLinkMeters={planSettings.maxLinkMeters}
              distanceBudgetMeters={planSettings.distanceBudgetMeters}
              onStatsChange={setWalkingGraphStats}
            />
            <TestRouteLayer result={testRoute} />
          </MapView>
        </main>
      </div>

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
