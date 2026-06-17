// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import type maplibregl from "maplibre-gl";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ClusterCandidate,
  ClusterDiagnostics,
  PlanResult,
} from "@gctp/shared/tours";
import {
  discoverClusters,
  listCaches,
  planLoop,
  saveTour,
  saveTourPreview,
  tourPreviewUrl,
} from "./lib/api.js";
import { planToGpxRoute, planToGpxTrack } from "./lib/gpx-export.js";
import { downloadGpx } from "./lib/gpx-download.js";
import { tourFilename } from "./lib/tour-filename.js";
import { captureMapSnapshot } from "./lib/map-snapshot.js";
import {
  useOnline,
  useRecheckConnectivity,
} from "./features/shell/ConnectivityProvider.js";
import { useTourSession } from "./features/tours/TourSessionProvider.js";
import {
  buildEditedPolyline,
  type LegPicks,
  planSignature,
  prunePlanEditKeys,
  useLocalStorageState,
} from "./lib/persistent-state.js";
import { DEFAULT_SEARCH, type SearchParams } from "./lib/search-params.js";
import { useDebouncedValue } from "./lib/use-debounced-value.js";
import type { ListCachesParams } from "./lib/api.js";
import { MapView } from "./features/map/MapView.js";
import {
  CachesLayer,
  type SelectedParking,
} from "./features/map/CachesLayer.js";
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
import { StartPointPickLayer } from "./features/map/StartPointPickLayer.js";
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
  TourSettingsPanel,
  type PlanSettings,
} from "./features/planning/PlannerSidebar.js";
import { ClusterCarousel } from "./features/planning/ClusterCarousel.js";
import {
  haloRadiusMeters,
  mergeCachesById,
} from "./features/planning/halo-caches.js";
import { UploadDropzone } from "./features/upload/UploadDropzone.js";
import {
  Crosshair,
  Download,
  Menu,
  Navigation,
  Route,
  Save,
  Wrench,
} from "lucide-react";
import { parkingNavTarget } from "./lib/maps.js";
import { analyticsEnabled } from "./lib/cloudflare-analytics.js";
import { Logo } from "./features/shell/Logo.js";
import { OfflineBadge, OfflineBanner } from "./features/shell/OfflineBadge.js";
import { JourneyRail } from "./features/shell/JourneyRail.js";
import { CommandPanel } from "./features/shell/CommandPanel.js";
import { AboutDialog } from "./features/shell/AboutDialog.js";
import { AdminToolsPanel } from "./features/shell/AdminToolsPanel.js";
import { JOURNEY_LABELS, type JourneyStep } from "./features/shell/journey.js";
import { useAuth } from "./features/auth/AuthProvider.js";

/**
 * Stable key over just the settings (+ user-supplied start) that feed
 * `planLoop`. Used to detect when the Tour step's controls have drifted from
 * the settings the current `planResult` was built with, so we can surface a
 * "settings changed → Replan" affordance. Excludes `avgWalkingKmh`, which is
 * a client-side display factor (tour stats recompute live, no replan needed).
 */
function planLoopSettingsKey(
  s: PlanSettings,
  pickedStart: readonly [number, number] | null,
): string {
  return JSON.stringify({
    distanceBudgetMeters: s.distanceBudgetMeters,
    timePerCacheMinutes: s.timePerCacheMinutes,
    toolBonusMinutes: s.toolBonusMinutes,
    startPreference: s.startPreference,
    maxLinkMeters: s.maxLinkMeters,
    fringeTrimMeters: s.fringeTrimMeters,
    osmParkingAccessFilter: [...s.osmParkingAccessFilter].sort(),
    osmParkingFeeFilter: s.osmParkingFeeFilter,
    // The start rides on the map-picked point now (not the search center), so
    // re-picking a start flags the plan stale.
    userStart: s.startPreference === "user-supplied-point" ? pickedStart : null,
  });
}

/**
 * Stable key over EVERY input to `discoverClusters` — the search params that
 * define the cluster pool plus the discovery-influencing plan settings. When
 * this drifts after clusters were discovered, the discovered clusters no longer
 * match the inputs → we mark them stale and prompt a re-discover (so a moved
 * circle, a tighter filter, or a changed clustering knob all surface the
 * "Re-discover" affordance).
 */
function discoverInputKey(p: SearchParams, s: PlanSettings): string {
  return JSON.stringify({
    // Search pool
    center: p.center,
    radiusM: p.radiusM,
    types: [...p.types].sort(),
    excludeFound: p.excludeFound,
    contexts: [...p.contexts].sort(),
    includeDisabled: p.includeDisabled,
    solvedMysteriesOnly: p.solvedMysteriesOnly,
    multiSubtype: p.multiSubtype,
    hideToolCaches: p.hideToolCaches,
    // Discovery settings (all feed discoverClusters)
    minClusterSize: s.minClusterSize,
    maxLinkMeters: s.maxLinkMeters,
    distanceBudgetMeters: s.distanceBudgetMeters,
    clusteringStrategy: s.clusteringStrategy,
    topNClusters: s.topNClusters,
    landuseWeight: s.landuseWeight,
    landuseProfileId: s.landuseProfileId ?? null,
    startPreference: s.startPreference,
    osmParkingAccessFilter: [...s.osmParkingAccessFilter].sort(),
    osmParkingFeeFilter: s.osmParkingFeeFilter,
  });
}

/** Shared tooltip for online-only controls disabled while offline. */
const OFFLINE_REASON = "Unavailable offline — reconnect to continue.";

export default function App(): JSX.Element {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const onLogout = useCallback(async () => {
    await logout();
    // An explicit sign-out lands on the public welcome page, not the login form.
    void navigate({ to: "/welcome" });
  }, [logout, navigate]);
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
  // One-time teaching hint for the reticle: shown in the Find step until the
  // user pans for the first time, then never again.
  const [reticleHintSeen, setReticleHintSeen] = useLocalStorageState<boolean>(
    "reticle-hint-seen",
    false,
  );
  const [clusters, setClusters] = useState<ClusterCandidate[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<ClusterDiagnostics | null>(
    null,
  );
  const [chosenClusterId, setChosenClusterId] = useState<string | null>(null);
  const [focusedClusterId, setFocusedClusterId] = useState<string | null>(null);
  // Discover-input key captured when clusters were discovered. Compared against
  // the live inputs to light up the "Re-discover" stale guard.
  const [discoveredInputKey, setDiscoveredInputKey] = useState<string | null>(
    null,
  );
  // `planLoopSettingsKey` snapshot captured at the start of the request that
  // produced the current `planResult`. Compared against the live settings to
  // light up the Tour step's "Replan" affordance when they drift.
  const pendingPlanKeyRef = useRef<string | null>(null);
  const [plannedKey, setPlannedKey] = useState<string | null>(null);
  /**
   * Most recently clicked parking spot — drives the yellow dotted line to
   * the cache that listed it.
   */
  const [selectedParking, setSelectedParking] =
    useState<SelectedParking | null>(null);
  // Ephemeral, online-only output of the live planning flow (discover → plan).
  // The OTHER source of a renderable plan — an opened *saved* tour — is owned by
  // `TourSessionProvider` (durable, offline). The two are reconciled into a
  // single `planResult` below.
  const [plannedResult, setPlannedResultRaw] = useState<PlanResult | null>(
    null,
  );
  /**
   * Authoritative connectivity (probes `/api/health`), decoupled from tile
   * rendering so cached tiles can't make it flap. When offline, an opened tour
   * with a snapshot shows the snapshot in place of the live map.
   */
  const online = useOnline();
  const recheckConnectivity = useRecheckConnectivity();
  /**
   * The opened saved tour — single source of truth (persisted id + IndexedDB +
   * React Query). Everything tour-related (`tourCaches`, the snapshot flag, the
   * open error) is derived here, not scattered through App state/effects.
   */
  const {
    openTourId,
    detail: openedDetail,
    planResult: openedPlan,
    tourCaches,
    openedTour,
    error: tourError,
    closeTour,
    markPreviewCaptured,
  } = useTourSession();
  // A freshly planned cluster wins over an opened tour (matches the old
  // clear-on-plan behaviour — now a derivation, not a side-effect).
  const planResult = plannedResult ?? openedPlan;
  const viewingOpenedTour = plannedResult === null && openedPlan !== null;
  /** Manual cluster selection (shift-click markers) — drives the Cluster Lab. */
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
  // Bottom obstruction (px) from the mobile command sheet — reported by
  // CommandPanel. Map-fit adds it as bottom padding so framed clusters/tours
  // land in the visible area above the sheet instead of behind it. 0 on desktop.
  const [mapBottomInset, setMapBottomInset] = useState(0);

  // ── Manual plan-edit state (FR-E2..E6) ──────────────────────────────
  const [editMode, setEditMode] = useLocalStorageState<boolean>(
    "edit-mode",
    false,
  );
  // ── Journey step (map-first overhaul) ────────────────────────────────
  // The mandatory flow: Find caches → Pick a cluster → Plan & export.
  // Persisted so a reload doesn't bounce the user back to step 1 mid-edit.
  const [activeStep, setActiveStep] = useLocalStorageState<JourneyStep>(
    "ui:active-step",
    "caches",
  );
  const [toolsOpen, setToolsOpen] = useState(false);
  // Mobile header overflow → collapse the nav actions into a hamburger menu.
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [selectedLegIndex, setSelectedLegIndex] = useState<number | null>(null);
  // Map-picked start point ([lng, lat]) for startPreference="user-supplied-point".
  // Set by clicking the map; replaces the old "use search center" auto-fill.
  const [pickedStart, setPickedStart] = useState<[number, number] | null>(null);
  // "Pick a point on the map" is selected but the user hasn't clicked yet —
  // block planning (the API requires userSuppliedStart for this mode).
  const needsPickedStart =
    planSettings.startPreference === "user-supplied-point" && !pickedStart;
  const [previewAlternativeIndex, setPreviewAlternativeIndex] = useState<
    number | null
  >(null);
  const [viaDrag, setViaDrag] = useState<ViaDragState | null>(null);
  const currentPlanSignature = planResult ? planSignature(planResult) : null;
  const [legPicks, setLegPicks] = useLocalStorageState<LegPicks>(
    currentPlanSignature
      ? `plan-edits:${currentPlanSignature}`
      : "plan-edits:none",
    {},
  );
  useEffect(() => {
    if (currentPlanSignature) prunePlanEditKeys(currentPlanSignature);
  }, [currentPlanSignature]);

  const isAdmin = user?.isAdmin === true;

  // A fresh plan jumps the user into the Tour step so the result is in view.
  // Setting a planned result supersedes any opened tour (see `planResult`
  // derivation), so also drop the opened-tour session here.
  const setPlannedResult = useCallback(
    (next: PlanResult | null) => {
      setPlannedResultRaw(next);
      if (next) {
        setActiveStep("tour");
        closeTour();
      }
      setSelectedLegIndex(null);
      setPreviewAlternativeIndex(null);
      setViaDrag(null);
    },
    [setActiveStep, closeTour],
  );

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

  // ── Plan-loop mutation ───────────────────────────────────────────────
  const planMutation = useMutation({
    mutationFn: async (cluster: ClusterCandidate) => {
      setChosenClusterId(cluster.clusterId);
      pendingPlanKeyRef.current = planLoopSettingsKey(
        planSettings,
        pickedStart,
      );
      return planLoop({
        cacheIds: cluster.cacheIds,
        distanceBudgetMeters: planSettings.distanceBudgetMeters,
        timePerCacheMinutes: planSettings.timePerCacheMinutes,
        toolBonusMinutes: planSettings.toolBonusMinutes,
        startPreference: planSettings.startPreference,
        maxLinkMeters: planSettings.maxLinkMeters,
        fringeTrimMeters: planSettings.fringeTrimMeters,
        ...(planSettings.startPreference === "user-supplied-point" &&
        pickedStart
          ? { userSuppliedStart: pickedStart }
          : {}),
        osmParkingAccessFilter: [...planSettings.osmParkingAccessFilter],
        osmParkingFeeFilter: planSettings.osmParkingFeeFilter,
      });
    },
    onSuccess: (res) => {
      setPlannedKey(pendingPlanKeyRef.current);
      // `setPlannedResult` supersedes any opened tour (closeTour) and jumps to
      // the Tour step — see its definition.
      setPlannedResult(res);
    },
  });
  const planCluster = useCallback(
    (cluster: ClusterCandidate) => {
      if (!online) return;
      planMutation.mutate(cluster);
    },
    [online, planMutation],
  );

  // ── Save tour (M6-γ, FR-P1) ──────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: (name: string) => {
      if (!planResult) throw new Error("No tour to save");
      return saveTour({ name, plan: planResult });
    },
  });
  const onSaveTour = useCallback(() => {
    if (!planResult || saveMutation.isPending || !online) return;
    const name = window.prompt("Name this tour")?.trim();
    if (!name) return;
    saveMutation.mutate(name, {
      onSuccess: async (detail) => {
        // Snapshot the framed tour for its offline preview / list thumbnail
        // (FR-W4) BEFORE navigating away unmounts the map. Capture the blob
        // synchronously (the tour is already drawn + idle), then upload in the
        // background — best-effort, never blocks the save or the nav.
        const map = mapRef.current;
        if (map) {
          const blob = await captureMapSnapshot(map);
          if (blob)
            void saveTourPreview(detail.id, blob)
              // Refresh My Tours so the new thumbnail shows without a manual
              // reload (the list was fetched before the upload landed).
              .then(() =>
                queryClient.invalidateQueries({ queryKey: ["tours"] }),
              )
              .catch(() => {});
        }
        void navigate({ to: "/tours" });
      },
    });
  }, [planResult, saveMutation, navigate, queryClient, online]);

  // ── Opened saved tour (M6-γ, FR-P2.2 / FR-W3) ────────────────────────
  // Opening, resuming, switching and the offline-durable data all live in
  // `TourSessionProvider`; `MyToursPage` calls `openTour(id)`. Here we only
  // react to a tour becoming the active view: drop ephemeral planning context
  // and surface it on the Tour step. Single trigger, no refs/mount-guards.
  useEffect(() => {
    if (!openedPlan) return;
    setPlannedResultRaw(null);
    setChosenClusterId(null);
    setActiveStep("tour");
  }, [openTourId, openedPlan, setActiveStep]);

  // Backfill a missing offline snapshot for a freshly opened tour (saved before
  // FR-W4 or whose capture failed). Online only — offline has no fresh tiles.
  // Once per tour id; updates the session's cached `hasPreview`.
  const backfilledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!openedDetail || openedDetail.hasPreview || !online) return;
    if (backfilledRef.current === openedDetail.id) return;
    const map = mapRef.current;
    if (!map) return;
    const id = openedDetail.id;
    backfilledRef.current = id;
    void captureMapSnapshot(map, { awaitNextIdle: true }).then((blob) => {
      if (!blob) return;
      void saveTourPreview(id, blob)
        .then(() => {
          markPreviewCaptured(id);
          return queryClient.invalidateQueries({ queryKey: ["tours"] });
        })
        .catch(() => {});
    });
  }, [openedDetail, online, markPreviewCaptured, queryClient]);

  // A fresh search (center/radius change) is a new exploration → leave the
  // opened tour. Opening a tour fits the map via fitBounds (not setParams), so
  // this never fires on open. Skip the mount run so a resumed tour survives the
  // initial render (params are restored from localStorage on mount).
  const searchChangeMountRef = useRef(true);
  useEffect(() => {
    if (searchChangeMountRef.current) {
      searchChangeMountRef.current = false;
      return;
    }
    closeTour();
  }, [params.center, params.radiusM, closeTour]);

  // Picking a cluster makes it the Tour context (and clears a stale result
  // from a previously-picked cluster) WITHOUT switching steps — the user
  // advances by pressing "Plan", which jumps to the Tour step on success.
  const pickCluster = useCallback(
    (cluster: ClusterCandidate) => {
      if (cluster.clusterId !== chosenClusterId) {
        setPlannedResultRaw(null);
        setPlannedKey(null);
      }
      setChosenClusterId(cluster.clusterId);
    },
    [chosenClusterId],
  );

  // ── Discover-clusters mutation ───────────────────────────────────────
  const discoverMutation = useMutation({
    mutationFn: async () => {
      return discoverClusters({
        center: params.center,
        radiusM: params.radiusM,
        minClusterSize: planSettings.minClusterSize,
        maxLinkMeters: planSettings.maxLinkMeters,
        distanceBudgetMeters: planSettings.distanceBudgetMeters,
        hardFilters: {
          types: params.types.length > 0 ? params.types : undefined,
          solvedMysteriesOnly: params.solvedMysteriesOnly || undefined,
          multiSubtype:
            params.multiSubtype !== "all" ? params.multiSubtype : undefined,
          hideToolCaches: params.hideToolCaches || undefined,
          contexts: params.contexts.length > 0 ? params.contexts : undefined,
        },
        softPreferences: {
          clusterDensityWeight: 1,
          loopCompactnessWeight: 1,
          landuseWeight: planSettings.landuseWeight,
          ...(planSettings.landuseProfileId
            ? { landuseProfileId: planSettings.landuseProfileId }
            : {}),
        },
        startPreference: planSettings.startPreference,
        clusteringStrategy: planSettings.clusteringStrategy,
        topNClusters: planSettings.topNClusters,
        // Cluster discovery (Pass 1) doesn't use the start point — it's a
        // Pass-2 parking concern — so we no longer send it here. The map-picked
        // start rides only on planLoop.
        osmParkingAccessFilter: [...planSettings.osmParkingAccessFilter],
        osmParkingFeeFilter: planSettings.osmParkingFeeFilter,
      });
    },
    onSuccess: (res) => {
      setClusters(res.candidates);
      setDiagnostics(res.diagnostics);
      setPlannedKey(null);
      // Discovering a new pool abandons any planned result and opened tour.
      setPlannedResultRaw(null);
      closeTour();
      setDiscoveredInputKey(discoverInputKey(params, planSettings));
      // Pre-pick the top candidate so the "Pick a cluster" peek shows the
      // carousel + an active "Plan cluster #1" button by default (no camera
      // move — framing happens when the user taps/swipes a card).
      const first = res.candidates[0]?.clusterId ?? null;
      setChosenClusterId(first);
      setFocusedClusterId(first);
    },
  });
  const onDiscover = useCallback(() => {
    if (!online) return;
    setActiveStep("clusters");
    discoverMutation.mutate();
  }, [online, discoverMutation, setActiveStep]);

  // Cache IDs feeding the parking-preview layer.
  const parkingPreviewCacheIds = useMemo<readonly number[]>(() => {
    if (planResult) return planResult.orderedCacheIds;
    if (focusedClusterId && clusters) {
      const focused = clusters.find((c) => c.clusterId === focusedClusterId);
      if (focused) return focused.cacheIds;
    }
    return [];
  }, [planResult, focusedClusterId, clusters]);

  // Canonical caches-query input (server-relevant params only).
  const cacheQueryInput = useMemo<ListCachesParams>(
    () => ({
      center: params.center,
      radiusM: params.radiusM,
      types: params.types.length > 0 ? params.types : undefined,
      excludeFound: params.excludeFound || undefined,
      contexts: params.contexts.length > 0 ? params.contexts : undefined,
      includeDisabled: params.includeDisabled || undefined,
      solvedMysteriesOnly: params.solvedMysteriesOnly || undefined,
      multiSubtype:
        params.multiSubtype !== "all" ? params.multiSubtype : undefined,
      hideToolCaches: params.hideToolCaches || undefined,
    }),
    [
      params.center,
      params.radiusM,
      params.types,
      params.excludeFound,
      params.contexts,
      params.includeDisabled,
      params.solvedMysteriesOnly,
      params.multiSubtype,
      params.hideToolCaches,
    ],
  );
  const debouncedCacheInput = useDebouncedValue(cacheQueryInput, 350);

  const cachesQuery = useQuery({
    queryKey: ["caches", debouncedCacheInput],
    queryFn: ({ signal }) => listCaches(debouncedCacheInput, signal),
    // Don't poll a dead network offline; keep the last-fetched caches on screen.
    enabled: online,
    placeholderData: (prev) => prev,
  });

  // Boundary-halo caches. Discovery (ADR-0026, PLANNER_CLUSTER_GROW) builds its
  // pool out to `radiusM + distanceBudgetMeters/2` — see clustering/context.ts —
  // so an edge-straddling cluster can include members beyond the search circle.
  // The main `cachesQuery` is radius-bounded, so those members would have no
  // marker (the count says 10, the map draws 1). Fetch the grown radius once
  // clusters exist and union it in so the visible set is a superset of the
  // clustered set. `excludeFound: true` mirrors the discovery pool (members are
  // never found-by-me caches); when grow is off server-side the extra caches are
  // simply never cluster members and the preview ignores them.
  const haloCacheInput = useMemo<ListCachesParams>(
    () => ({
      ...debouncedCacheInput,
      radiusM: haloRadiusMeters(
        debouncedCacheInput.radiusM,
        planSettings.distanceBudgetMeters,
      ),
      excludeFound: true,
    }),
    [debouncedCacheInput, planSettings.distanceBudgetMeters],
  );
  const haloCachesQuery = useQuery({
    queryKey: ["caches", haloCacheInput],
    queryFn: ({ signal }) => listCaches(haloCacheInput, signal),
    enabled: clusters !== null && online,
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
    [setParams],
  );

  const handlePickCenter = useCallback(
    (lngLat: [number, number]) => {
      setParams((prev) => ({ ...prev, center: lngLat }));
      // The user just panned the reticle — they've learned the model.
      setReticleHintSeen(true);
    },
    [setParams, setReticleHintSeen],
  );

  // ── Map auto-fit helper ──────────────────────────────────────────────
  const fitToCoordinates = useCallback(
    (coords: ReadonlyArray<readonly [number, number]>) => {
      if (!mapRef.current || coords.length === 0) return;
      let minLng = coords[0]![0];
      let minLat = coords[0]![1];
      let maxLng = minLng;
      let maxLat = minLat;
      for (const [lng, lat] of coords) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      mapRef.current.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        {
          // Extra bottom padding keeps the framed content clear of the mobile
          // bottom sheet (0 on desktop).
          padding: {
            top: 60,
            left: 40,
            right: 40,
            bottom: 60 + mapBottomInset,
          },
          duration: 600,
          maxZoom: 16,
        },
      );
    },
    [mapBottomInset],
  );

  // Union the radius-bounded set with the boundary halo so every cluster member
  // resolves to a marker / coordinate (camera-fit, preview, carousel, export,
  // GPX). Halo is only present once clusters are discovered; before that this is
  // just the base set.
  const caches = useMemo(
    () =>
      mergeCachesById(
        mergeCachesById(cachesQuery.data?.caches, haloCachesQuery.data?.caches),
        tourCaches ?? undefined,
      ),
    [cachesQuery.data, haloCachesQuery.data, tourCaches],
  );

  // Explicit "frame this cluster" — the ONLY place a cluster tap moves the
  // camera. Sets emphasis + picks it as the Tour context. Hover does NOT
  // call this (it only sets `focusedClusterId` for styling).
  const frameCluster = useCallback(
    (cluster: ClusterCandidate) => {
      setFocusedClusterId(cluster.clusterId);
      pickCluster(cluster);
      if (caches) {
        const byId = new Map(caches.map((c) => [c.id, c]));
        const coords: [number, number][] = [];
        for (const id of cluster.cacheIds) {
          const c = byId.get(id);
          if (c) coords.push(c.location.coordinates as [number, number]);
        }
        fitToCoordinates(coords);
      }
    },
    [caches, fitToCoordinates, pickCluster],
  );
  const frameClusterById = useCallback(
    (id: string) => {
      const c = clusters?.find((x) => x.clusterId === id);
      if (c) frameCluster(c);
    },
    [clusters, frameCluster],
  );

  // ── Derivations ──────────────────────────────────────────────────────
  const cacheCount = caches?.length ?? 0;
  const clustersStepEnabled = cacheCount > 0;
  const tourStepEnabled = planResult !== null || chosenClusterId !== null;
  const chosenCluster =
    clusters?.find((c) => c.clusterId === chosenClusterId) ?? null;
  const chosenClusterRank = chosenCluster
    ? (clusters?.findIndex((c) => c.clusterId === chosenClusterId) ?? -1) + 1
    : 0;
  const planStale =
    planResult !== null &&
    plannedKey !== null &&
    planLoopSettingsKey(planSettings, pickedStart) !== plannedKey;
  const clustersStale =
    clusters !== null &&
    clusters.length > 0 &&
    discoveredInputKey !== null &&
    discoverInputKey(params, planSettings) !== discoveredInputKey;
  const replan = useCallback(() => {
    if (chosenCluster) planCluster(chosenCluster);
  }, [chosenCluster, planCluster]);

  // "Find clusters →" on the Find step: navigate straight to the carousel when
  // clusters already exist and are fresh (no recompute); otherwise discover.
  const goToClusters = useCallback(() => {
    if (clusters && clusters.length > 0 && !clustersStale) {
      setActiveStep("clusters");
    } else {
      onDiscover();
    }
  }, [clusters, clustersStale, setActiveStep, onDiscover]);

  // Quick GPX export straight from the Tour peek — edit-aware (respects leg
  // swaps / via-points) via the shared `buildEditedPolyline`.
  const saveGpx = useCallback(
    (mode: "track" | "route") => {
      if (!planResult) return;
      const edited = buildEditedPolyline(planResult, legPicks);
      const text =
        mode === "track"
          ? planToGpxTrack(
              planResult,
              caches,
              undefined,
              edited !== planResult.polyline ? edited : undefined,
            )
          : planToGpxRoute(planResult, caches);
      void downloadGpx({
        text,
        filename: tourFilename(planResult, mode, new Date()),
        mimeType: "application/gpx+xml",
      });
    },
    [planResult, caches, legPicks],
  );

  const selectStep = useCallback(
    (step: JourneyStep) => {
      if (step === "clusters" && cacheCount === 0) return;
      if (step === "tour" && !tourStepEnabled) return;
      setActiveStep(step);
    },
    [cacheCount, tourStepEnabled, setActiveStep],
  );

  // Frame the whole search circle (center ± radius). Used on entering the Find
  // step, when the radius changes there, and as the caches-phase fallback.
  const frameCircle = useCallback(() => {
    const [lng, lat] = params.center;
    const r = params.radiusM;
    const dLat = r / 111_320;
    const dLng = r / (111_320 * Math.cos((lat * Math.PI) / 180));
    fitToCoordinates([
      [lng - dLng, lat - dLat],
      [lng + dLng, lat + dLat],
    ]);
  }, [params.center, params.radiusM, fitToCoordinates]);

  // Frame the map context for a given phase — the consistent "where am I"
  // re-centre used on every phase change AND by the ⊕ Frame control:
  //   caches   → the whole search circle (center ± radius)
  //   clusters → the chosen/focused cluster (else all candidates, else circle)
  //   tour     → the routed tour polyline (else fall through)
  const frameStep = useCallback(
    (step: JourneyStep) => {
      const byId = caches ? new Map(caches.map((c) => [c.id, c])) : null;
      const coordsFor = (ids: Iterable<number>): [number, number][] => {
        const out: [number, number][] = [];
        if (!byId) return out;
        for (const id of ids) {
          const c = byId.get(id);
          if (c) out.push(c.location.coordinates as [number, number]);
        }
        return out;
      };

      if (step === "tour" && planResult) {
        fitToCoordinates(
          planResult.polyline.coordinates as ReadonlyArray<[number, number]>,
        );
        return;
      }
      if (step === "clusters" && clusters && clusters.length > 0) {
        const targetId = chosenClusterId ?? focusedClusterId;
        const target = targetId
          ? clusters.find((c) => c.clusterId === targetId)
          : null;
        const coords = target
          ? coordsFor(target.cacheIds)
          : coordsFor(new Set(clusters.flatMap((c) => c.cacheIds)));
        if (coords.length > 0) {
          fitToCoordinates(coords);
          return;
        }
      }
      // caches phase, or any fallback → show the search area.
      frameCircle();
    },
    [
      planResult,
      clusters,
      chosenClusterId,
      focusedClusterId,
      caches,
      frameCircle,
    ],
  );
  const frameContext = useCallback(
    () => frameStep(activeStep),
    [frameStep, activeStep],
  );

  // Re-frame the map on every explicit phase change (rail click, peek CTA, or
  // the auto-jump to Tour on plan-success). Reads the latest `frameStep` via a
  // ref so the dep list stays `[activeStep]` — Discover (which mutates
  // `clusters`) never triggers a re-frame, and the first mount is skipped so a
  // reload honors the persisted viewport.
  const frameStepRef = useRef(frameStep);
  frameStepRef.current = frameStep;
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    frameStepRef.current(activeStep);
  }, [activeStep]);

  // Fit the camera to the search circle when its radius changes in the Find
  // step, so growing/shrinking the circle zooms to keep it framed. Debounced so
  // dragging the radius slider doesn't fly on every tick; the first run is
  // skipped so it never fires on mount / reload. Reads `activeStep` + the framer
  // through refs so the dep list is `[debouncedRadiusM]` alone — otherwise a
  // pan (which changes `frameCircle`'s identity) would re-fit and fight the pan.
  const debouncedRadiusM = useDebouncedValue(params.radiusM, 250);
  const frameCircleRef = useRef(frameCircle);
  frameCircleRef.current = frameCircle;
  const activeStepRef = useRef(activeStep);
  activeStepRef.current = activeStep;
  const didRadiusFitMountRef = useRef(false);
  useEffect(() => {
    if (!didRadiusFitMountRef.current) {
      didRadiusFitMountRef.current = true;
      return;
    }
    if (activeStepRef.current !== "caches") return;
    frameCircleRef.current();
  }, [debouncedRadiusM]);

  // Esc closes the admin tools drawer; lock body scroll while it's open.
  useEffect(() => {
    if (!toolsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setToolsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [toolsOpen]);

  // Refit the tour when a REPLAN changes its geometry while already on the Tour
  // step. (Entry-framing is handled by the phase-change effect above; mount is
  // skipped so a reload honors the persisted viewport.)
  const lastPlanRef = useRef(planResult);
  useEffect(() => {
    const changed = lastPlanRef.current !== planResult;
    lastPlanRef.current = planResult;
    if (!changed) return;
    if (activeStep === "tour" && planResult) {
      fitToCoordinates(
        planResult.polyline.coordinates as ReadonlyArray<[number, number]>,
      );
    }
  }, [planResult, activeStep, fitToCoordinates]);

  // ── Journey-rail state ───────────────────────────────────────────────
  // Find + cluster discovery hit the live API; offline they're locked. The tour
  // step stays reachable so an opened/planned tour can still export & show its
  // offline snapshot.
  const railEnabled: Record<JourneyStep, boolean> = {
    caches: online,
    clusters: clustersStepEnabled && online,
    tour: tourStepEnabled,
  };
  const railDone: Record<JourneyStep, boolean> = {
    caches: cacheCount > 0,
    clusters: chosenClusterId !== null,
    tour: planResult !== null,
  };
  const railLocked: Partial<Record<JourneyStep, string>> = {
    caches: online ? undefined : "Finding caches needs a connection.",
    clusters: online
      ? "Upload a GPX or widen the search to see caches first."
      : "Cluster discovery needs a connection.",
    tour: "Pick a cluster first.",
  };

  // ── Per-step command-panel content ───────────────────────────────────
  const peek = renderPeek();
  const body = renderBody();

  function renderPeek(): JSX.Element {
    if (activeStep === "caches") {
      return (
        <div className="step-peek">
          <span className="step-peek__stat">
            {cachesQuery.isFetching
              ? "Loading…"
              : `${cacheCount} cache${cacheCount === 1 ? "" : "s"} in radius`}
          </span>
          <button
            type="button"
            className="primary"
            disabled={cacheCount === 0 || !online}
            onClick={goToClusters}
            title={
              !online
                ? OFFLINE_REASON
                : cacheCount === 0
                  ? "Load caches first (upload a GPX or widen the radius)."
                  : clustersStale
                    ? "Search/discovery settings changed — re-run discovery"
                    : clusters && clusters.length > 0
                      ? "Go to your discovered clusters"
                      : "Find walkable cluster loops from these caches"
            }
          >
            {clustersStale ? "Re-discover →" : "Find clusters →"}
          </button>
        </div>
      );
    }
    if (activeStep === "clusters") {
      const hasClusters = clusters !== null && clusters.length > 0;
      return (
        <div className="step-peek step-peek--stack">
          {clustersStale && (
            <div className="stale-banner">
              Search area changed — clusters may be out of date.
              <button
                type="button"
                className="primary"
                onClick={onDiscover}
                disabled={discoverMutation.isPending || !online}
                title={!online ? OFFLINE_REASON : undefined}
              >
                {discoverMutation.isPending ? "Searching…" : "Re-discover"}
              </button>
            </div>
          )}
          {!hasClusters && !clustersStale && (
            <button
              type="button"
              className="primary"
              onClick={onDiscover}
              disabled={discoverMutation.isPending || !online}
              title={!online ? OFFLINE_REASON : undefined}
            >
              {discoverMutation.isPending ? "Searching…" : "Discover clusters"}
            </button>
          )}
          {hasClusters && (
            <>
              <ClusterCarousel
                clusters={clusters}
                chosenClusterId={chosenClusterId}
                focusedClusterId={focusedClusterId}
                onPick={frameCluster}
                onFocus={setFocusedClusterId}
                avgWalkingKmh={planSettings.avgWalkingKmh}
                timePerCacheMinutes={planSettings.timePerCacheMinutes}
              />
              {chosenCluster ? (
                <button
                  type="button"
                  className="primary"
                  onClick={() => planCluster(chosenCluster)}
                  disabled={
                    planMutation.isPending || needsPickedStart || !online
                  }
                  title={!online ? OFFLINE_REASON : undefined}
                >
                  {planMutation.isPending
                    ? "Planning…"
                    : needsPickedStart
                      ? "Click the map to set your start"
                      : `Plan cluster #${chosenClusterRank} (${chosenCluster.cacheIds.length} caches)`}
                </button>
              ) : (
                <span className="muted">
                  Swipe or tap a cluster to pick it.
                </span>
              )}
            </>
          )}
        </div>
      );
    }
    // tour — a planned (or opened-saved) tour shows its stats + a prominent
    // "Navigate to parking" link right in the always-visible peek.
    if (planResult) {
      const totalMin =
        planResult.totals.seconds / 60 + planResult.totals.visitMinutes;
      const parkingNav = parkingNavTarget(planResult.parking.point);
      return (
        <div className="step-peek step-peek--stack">
          <div className="tour-peek__row">
            <span className="tour-peek__stats">
              <strong>{(planResult.totals.meters / 1000).toFixed(1)} km</strong>
              <span className="tour-peek__sep">·</span>
              {formatDurationMin(totalMin)}
              <span className="tour-peek__sep">·</span>
              {planResult.orderedCacheIds.length} caches
              {planStale && !planMutation.isPending && (
                <span className="badge badge--stale">settings changed</span>
              )}
            </span>
            {chosenCluster && (
              <button
                type="button"
                className="primary"
                onClick={replan}
                disabled={planMutation.isPending || needsPickedStart || !online}
                title={!online ? OFFLINE_REASON : undefined}
              >
                {planMutation.isPending
                  ? "Planning…"
                  : needsPickedStart
                    ? "Set start"
                    : "Replan"}
              </button>
            )}
          </div>
          <a
            className="tour-peek__navigate"
            href={parkingNav.href}
            {...(parkingNav.external
              ? { target: "_blank", rel: "noreferrer" }
              : {})}
            title="Navigate to the parking (opens your maps app; works offline)"
          >
            <Navigation size={16} aria-hidden="true" /> Navigate to parking
          </a>
          <div className="gpx-quick">
            <button
              type="button"
              className="primary"
              onClick={onSaveTour}
              disabled={saveMutation.isPending || !online}
              title={
                !online
                  ? OFFLINE_REASON
                  : "Save this tour to My Tours so you can re-open it later."
              }
            >
              {saveMutation.isPending ? (
                "Saving…"
              ) : (
                <>
                  <Save size={16} aria-hidden="true" /> Save tour
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => saveGpx("track")}
              title="Download a GPX track — your device follows the exact route on the map."
            >
              <Download size={16} aria-hidden="true" /> GPX track
            </button>
            <button
              type="button"
              onClick={() => saveGpx("route")}
              title="Download a GPX route — parking + each cache as waypoints; the device navigates between them."
            >
              GPX route
            </button>
          </div>
        </div>
      );
    }
    if (chosenCluster) {
      return (
        <div className="step-peek step-peek--stack">
          <div className="step-peek__row">
            <span className="step-peek__stat">
              Cluster #{chosenClusterRank} · {chosenCluster.cacheIds.length}{" "}
              caches
            </span>
            <button
              type="button"
              className="primary"
              onClick={replan}
              disabled={planMutation.isPending || needsPickedStart || !online}
              title={!online ? OFFLINE_REASON : undefined}
            >
              {planMutation.isPending
                ? "Planning…"
                : needsPickedStart
                  ? "Set start on map"
                  : "Plan"}
            </button>
          </div>
        </div>
      );
    }
    return <span className="muted">Pick a cluster first.</span>;
  }

  function renderBody(): JSX.Element {
    if (activeStep === "caches") {
      return (
        <>
          <UploadDropzone />
          <FilterSidebar
            value={params}
            onChange={handleParamsChange}
            cacheCount={cacheCount}
            loading={cachesQuery.isFetching}
          />
        </>
      );
    }
    if (activeStep === "clusters") {
      return (
        <PlannerSidebar
          search={params}
          settings={planSettings}
          onSettingsChange={setPlanSettings}
          hideClusterLab
          hideDebugOverlays
          clusters={clusters}
          onClustersChange={setClusters}
          diagnostics={diagnostics}
          onDiagnosticsChange={setDiagnostics}
          chosenClusterId={chosenClusterId}
          onChosenClusterChange={setChosenClusterId}
          focusedClusterId={focusedClusterId}
          onFocusClusterChange={setFocusedClusterId}
          result={planResult}
          onResultChange={setPlannedResult}
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
          onPlanCluster={frameCluster}
          planPending={planMutation.isPending}
          planPendingClusterId={planMutation.isPending ? chosenClusterId : null}
          planError={(planMutation.error as Error) ?? null}
          onDiscover={onDiscover}
          discoverPending={discoverMutation.isPending}
          discoverError={(discoverMutation.error as Error) ?? null}
          online={online}
        />
      );
    }
    // tour
    return (
      <>
        <TourSettingsPanel
          settings={planSettings}
          onSettingsChange={setPlanSettings}
          pickedStart={pickedStart}
          onClearPickedStart={() => setPickedStart(null)}
        />
        {planMutation.error && (
          <p className="error">{(planMutation.error as Error).message}</p>
        )}
        {planResult ? (
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
        ) : planMutation.isPending ? (
          <p className="muted">Planning your loop…</p>
        ) : chosenCluster ? (
          <p className="muted">
            Press <strong>Plan</strong> above to route this cluster.
          </p>
        ) : (
          <p className="muted">Pick a cluster (step 2) to plan its loop.</p>
        )}
      </>
    );
  }

  return (
    <div className="app">
      {/* Header + offline banner + open-tour error share ONE grid row (`.app`
          is `grid-template-rows: auto 1fr auto` — header / body / footer). The
          banner must NOT be a direct grid child or, when it appears offline, it
          steals the map's 1fr track and the map collapses. */}
      <div className="app-top">
        <header className="app-header">
          <Logo size={34} />
          <div className="app-header__title">
            <h1>gc-tour-planner</h1>
            <p>
              Plan closed-loop geocaching tours from filtered cache clusters.
            </p>
          </div>
          <OfflineBadge />
          {/* Desktop: inline actions. Hidden on mobile (collapsed into the menu). */}
          <div className="app-header__actions">
            {isAdmin && (
              <button
                type="button"
                className="app-header__tools"
                onClick={() => setToolsOpen((v) => !v)}
                aria-expanded={toolsOpen}
                aria-controls="tools-drawer"
                title="Admin tools (precompute, cluster lab, debug overlays)"
              >
                <Wrench size={16} aria-hidden="true" />
                <span className="app-header__tools-label">Admin</span>
              </button>
            )}
            {user && (
              <div className="app-header__user">
                <Link
                  to="/tours"
                  className="app-header__tours"
                  title="Your saved tours"
                >
                  My tours
                </Link>
                <Link
                  to="/account"
                  className="app-header__tours"
                  title="Account & password"
                >
                  Account
                </Link>
                <span className="app-header__user-name" title={user.email}>
                  {user.displayName}
                </span>
                <button
                  type="button"
                  className="app-header__logout"
                  onClick={() => void onLogout()}
                  title="Sign out"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>

          {/* My Tours stays a first-class, always-visible action (icon on mobile,
            where the rest collapse into the hamburger). */}
          {user && (
            <Link
              to="/tours"
              className="app-header__tours-quick"
              aria-label="My tours"
              title="Your saved tours"
            >
              <Route size={20} aria-hidden="true" />
            </Link>
          )}

          {/* Mobile: a hamburger that opens the same actions as a dropdown. */}
          {user && (
            <div className="app-header__menu-wrap">
              <button
                type="button"
                className="app-header__hamburger"
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
                aria-controls="header-menu"
                aria-label="Menu"
              >
                <Menu size={20} aria-hidden="true" />
              </button>
              {menuOpen && (
                <>
                  <div
                    className="app-header__menu-backdrop"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div
                    id="header-menu"
                    className="app-header__menu"
                    role="menu"
                  >
                    {isAdmin && (
                      <button
                        type="button"
                        className="app-header__menu-item"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          setToolsOpen(true);
                        }}
                      >
                        <Wrench size={16} aria-hidden="true" /> Admin tools
                      </button>
                    )}
                    <Link
                      to="/account"
                      className="app-header__menu-item"
                      role="menuitem"
                      onClick={() => setMenuOpen(false)}
                    >
                      Account
                    </Link>
                    <button
                      type="button"
                      className="app-header__menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setAboutOpen(true);
                      }}
                    >
                      About
                    </button>
                    <button
                      type="button"
                      className="app-header__menu-item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void onLogout();
                      }}
                    >
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </header>

        <OfflineBanner />

        {tourError && (
          <div className="open-tour-error" role="alert">
            <span>{tourError}</span>
            <button
              type="button"
              className="open-tour-error__dismiss"
              onClick={() => closeTour()}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      <div className="app-body">
        <main className="app-main">
          <MapView
            initialCenter={viewport?.center ?? params.center}
            initialZoom={viewport?.zoom ?? zoomForRadius(params.radiusM)}
            // A background tap is used ONLY to drop the user-supplied tour
            // start point. Tap-to-set-*center* is gone: in the Find step the
            // search circle is a viewport-centred reticle and panning the map
            // repositions it (see RadiusLayer).
            onPickCenter={
              planSettings.startPreference === "user-supplied-point"
                ? setPickedStart
                : undefined
            }
            onReady={(m) => {
              mapRef.current = m;
            }}
            onViewportChange={setViewport}
            onBasemapError={recheckConnectivity}
          >
            <LanduseLayer params={params} />
            <OsmParkingLayer
              access={planSettings.osmParkingAccessFilter}
              fee={planSettings.osmParkingFeeFilter}
            />
            <RadiusLayer
              params={params}
              interactive={activeStep === "caches"}
              onCenterChange={handlePickCenter}
            />
            <StartPointPickLayer
              point={
                planSettings.startPreference === "user-supplied-point" &&
                !planResult
                  ? pickedStart
                  : null
              }
            />
            <CachesLayer
              queryInput={debouncedCacheInput}
              extraCaches={tourCaches ?? undefined}
              selectedCacheIds={selectedCacheIds}
              onSelectionChange={setSelectedCacheIds}
              onParkingSelect={setSelectedParking}
              online={online}
            />
            <ClustersPreviewLayer
              candidates={clusters}
              caches={caches}
              focusedClusterId={focusedClusterId}
              onCentroidClick={frameClusterById}
              onCentroidHover={setFocusedClusterId}
            />
            <TourLayer
              result={planResult}
              caches={caches}
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
              caches={caches}
            />
            <WalkingGraphLayer
              enabled={showWalkingGraph}
              params={params}
              maxLinkMeters={planSettings.maxLinkMeters}
              distanceBudgetMeters={planSettings.distanceBudgetMeters}
              avgWalkingKmh={planSettings.avgWalkingKmh}
              onStatsChange={setWalkingGraphStats}
            />
            <TestRouteLayer result={testRoute} />
            <ZoomDebugBadge />
          </MapView>

          {/* Offline fallback: when basemap tiles can't load, show the opened
              tour's stored snapshot (FR-W4) — it bakes in the basemap + route.
              Driven by real tile load failures, not navigator.onLine. The image
              is an OSM-derived "Produced Work", so it carries OSM attribution. */}
          {viewingOpenedTour && openedTour?.hasPreview && !online && (
            <div className="map-offline-snapshot">
              <img
                src={tourPreviewUrl(openedTour.id)}
                alt="Saved tour map (offline)"
              />
              <span className="map-offline-snapshot__badge">
                Offline preview
              </span>
              <span className="map-offline-snapshot__attribution">
                © OpenStreetMap contributors
              </span>
            </div>
          )}

          <JourneyRail
            current={activeStep}
            enabled={railEnabled}
            done={railDone}
            lockedReason={railLocked}
            attention={{ clusters: clustersStale }}
            onSelect={selectStep}
          />

          {activeStep === "caches" && !reticleHintSeen && (
            <p className="map-reticle-hint" aria-hidden="true">
              Pan to aim
            </p>
          )}

          <button
            type="button"
            className="map-frame-btn"
            onClick={frameContext}
            aria-label="Frame current view"
            title="Re-center the map on the current step's content"
          >
            <Crosshair size={20} aria-hidden="true" />
          </button>
        </main>

        <CommandPanel
          title={JOURNEY_LABELS[activeStep]}
          stepKey={activeStep}
          peek={peek}
          onInsetChange={setMapBottomInset}
        >
          {body}
        </CommandPanel>
      </div>

      {isAdmin && (
        <AdminToolsPanel
          open={toolsOpen}
          onClose={() => setToolsOpen(false)}
          search={params}
          settings={planSettings}
          showWalkingGraph={showWalkingGraph}
          onShowWalkingGraphChange={setShowWalkingGraph}
          walkingGraphStats={walkingGraphStats}
          selectedCacheIds={selectedCacheIds}
          onSelectionChange={setSelectedCacheIds}
          testRoute={testRoute}
          onTestRouteChange={setTestRoute}
        />
      )}

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />

      <footer className="app-footer">
        Map data &copy;{" "}
        <a href="https://www.openstreetmap.org/copyright">
          OpenStreetMap contributors
        </a>
        {analyticsEnabled && (
          <>
            {" · "}
            Cookieless analytics via{" "}
            <a href="https://www.cloudflare.com/web-analytics/">Cloudflare</a>
          </>
        )}
      </footer>
    </div>
  );
}

/** Human total duration (walking + visit) for the tour peek headline. */
function formatDurationMin(totalMin: number): string {
  const m = Math.round(totalMin);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
}

function zoomForRadius(radiusM: number): number {
  if (radiusM <= 1_000) return 14;
  if (radiusM <= 2_500) return 13;
  if (radiusM <= 5_000) return 12;
  if (radiusM <= 10_000) return 11;
  if (radiusM <= 20_000) return 10;
  return 9;
}
