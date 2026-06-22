// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { createRoot } from "react-dom/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CacheDTO, CacheSummaryDTO, CacheType } from "@gctp/shared/caches";
import type { Tours } from "@gctp/shared";
import {
  clearSolvedCoordinates,
  fetchCacheDetail,
  listCaches,
  markCacheFound,
  unmarkCacheFound,
  type ListCachesParams,
} from "../../lib/api.js";
import { mergeCachesById } from "../planning/halo-caches.js";
import { clusterByPixelProximity, OVERLAP_PX } from "./pixel-cluster.js";
import { useMap } from "./MapContext.js";
import { CachePopup } from "./CachePopup.js";
import { PARKING_MIN_ZOOM } from "./parking-zoom.js";
import { isDragGesture } from "./pointer-drag.js";

const CACHES_SOURCE = "gctp-caches";
const CACHES_CIRCLE_LAYER = "gctp-caches-circle";
const CACHES_AL_CIRCLE_LAYER = "gctp-caches-al-circle";
// Transparent, generously-sized tap target over every cache. The cluster
// preview paints emphasis markers LARGER than the real cache circle and on top
// of it (ClustersPreviewLayer.FOCUS_CACHES_LAYER), so a finger tap landing on
// the emphasised marker but outside the small real circle would hit nothing.
// queryRenderedFeatures is geometry-based (opacity-0 is still hittable), so a
// hit circle sized ≥ every painted/emphasis radius decouples the tap target
// from the visible size — the click handler binds here, not the visible layers.
const CACHES_HIT_LAYER = "gctp-caches-hit";
const CACHES_DISABLED_LABEL_LAYER = "gctp-caches-disabled-label";
const CACHES_SOLVED_BADGE_LAYER = "gctp-caches-solved-badge";
const CACHES_AL_STAGE_LABEL_LAYER = "gctp-caches-al-stage-label";
// Linear Adventure Labs (FR-I18): their stages must be done in order, so each
// stage shows its number at the pin's top-right — drawn the way the tool-cache
// "T" badge is (a haloed glyph, NO background bubble), and kept on top so it's
// readable over the cluster-emphasis discs. Distinguishes linear from the plain
// centred S{n} of random-order ALs.
const CACHES_AL_LINEAR_BADGE_LABEL_LAYER = "gctp-caches-al-linear-badge-label";
const SELECTED_AL_STAGE_LAYER = "gctp-caches-selected-al-stage";
// Collapsed Adventure Labs (FR-I17): AL stages that overlap on screen collapse
// into one pin (the same pixel-proximity logic the planned tour uses — see
// ./pixel-cluster) and separate back into individual stages as the user zooms in.
// Non-AL caches are never collapsed, so density/cluster patterns stay readable.
const AL_ADVENTURES_SOURCE = "gctp-al-adventures";
const AL_ADVENTURE_CIRCLE_LAYER = "gctp-al-adventure-circle";
const AL_ADVENTURE_COUNT_LAYER = "gctp-al-adventure-count";
/** Below this zoom an S{n} stage label / collapsed-pin count is illegible. */
const AL_STAGE_LABEL_MINZOOM = PARKING_MIN_ZOOM;
/** Zoom a collapsed-pin click jumps to, to separate its overlapping stages. */
const AL_EXPLODE_ZOOM = PARKING_MIN_ZOOM;
/** addImage id for the canvas-drawn solved checkmark badge. */
const SOLVED_BADGE_ICON = "gctp-solved-check";

/**
 * Draw (once) a small green disc with a white checkmark and register it as a
 * map image, so the solved badge is a real checkmark. We can't use a "✓" text
 * glyph: the style's glyph source (demotiles) only serves basic-Latin ranges,
 * so U+2713 would 404 and render nothing. A canvas icon is glyph-independent.
 * Returns false when no 2D canvas is available (e.g. jsdom in tests) so the
 * caller can skip the badge layer rather than reference a missing image.
 */
function ensureSolvedBadgeIcon(map: maplibregl.Map): boolean {
  if (map.hasImage(SOLVED_BADGE_ICON)) return true;
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const c = size / 2;
  ctx.beginPath();
  ctx.arc(c, c, c - 1.5, 0, Math.PI * 2);
  ctx.fillStyle = "#2e7d32"; // solved green — distinct from the red selection ring
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(size * 0.28, size * 0.52);
  ctx.lineTo(size * 0.44, size * 0.69);
  ctx.lineTo(size * 0.74, size * 0.32);
  ctx.stroke();
  map.addImage(SOLVED_BADGE_ICON, ctx.getImageData(0, 0, size, size), {
    pixelRatio: 2,
  });
  return true;
}
const PARKING_SOURCE = "gctp-parking";
const PARKING_LAYER = "gctp-parking-circle";

const TYPE_COLORS: Record<CacheType, string> = {
  Traditional: "#2e7d32",
  Multi: "#f9a825",
  Mystery: "#1565c0",
  Letterbox: "#6a1b9a",
  EarthCache: "#4e342e",
  Event: "#c62828",
  Virtual: "#00838f",
  Webcam: "#558b2f",
  Wherigo: "#283593",
  CITO: "#2e7d32",
  "Adventure Lab": "#7b1fa2",
  Other: "#616161",
};

/**
 * Two independent dims that compose (applied to a marker's circle AND its
 * label/badge so a found/disabled cache recedes as a whole):
 *   * found-by-me → 0.35 (won't disappear, but recedes) — this is what dims a
 *     completed Adventure Lab stage exactly like a found regular cache.
 *   * disabled    → 0.50 (geocaching.com convention for temp-disabled).
 * Combining both gives ~0.18, still visible.
 */
const FOUND_DISABLED_OPACITY: maplibregl.ExpressionSpecification = [
  "*",
  ["case", ["==", ["get", "foundByMe"], 1], 0.35, 1],
  ["case", ["==", ["get", "disabled"], 1], 0.5, 1],
];

/**
 * Circle paint shared by the regular-cache layer and the (zoomed-in) Adventure
 * Lab stage layer, so both look identical — colour comes from the per-feature
 * `color` prop, and found/disabled dims compose the same way.
 */
const CACHE_CIRCLE_PAINT: maplibregl.CircleLayerSpecification["paint"] = {
  "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 4, 14, 9],
  "circle-color": ["get", "color"],
  "circle-stroke-color": "#ffffff",
  "circle-stroke-width": 1.5,
  "circle-opacity": FOUND_DISABLED_OPACITY,
  "circle-stroke-opacity": FOUND_DISABLED_OPACITY,
};

/**
 * Adventure Lab circle paint — identical to {@link CACHE_CIRCLE_PAINT} but a
 * touch smaller (z9→3, z14→8 vs the regular z9→4, z14→9). Used for BOTH the
 * individual AL stage and the collapsed pin so AL markers are uniformly slightly
 * smaller than a regular cache, and a collapsed pin never looks smaller than the
 * single stages it stands in for.
 */
const AL_CIRCLE_PAINT: maplibregl.CircleLayerSpecification["paint"] = {
  ...CACHE_CIRCLE_PAINT,
  "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3, 14, 8],
};

interface CacheProps {
  id: CacheDTO["id"];
  code: string;
  name: string;
  type: CacheType;
  color: string;
  foundByMe: number; // 0/1 — MapLibre filter expressions don't accept booleans
  selected: number; // 0/1 — same MapLibre-filter caveat
  /** 1 when the cache owner has temporarily disabled it (FR-I10). */
  disabled: number;
  /** 1 when `location` is a user-supplied solved/corrected coordinate. */
  solved: number;
  /** FR-SF1 count of `stages` additional waypoints. */
  stageCount: number;
  /** Adventure Lab deep-link GUID (AL stages only; null otherwise). */
  adventureId: string | null;
  /** AL stage position; 0 for non-AL (MapLibre filter expressions dislike null). */
  stageSequence: number;
  /** AL total stage count; 0 for non-AL. */
  stageTotal: number;
  /** 1 when this is a linear AL stage (visited in order); 0 otherwise/non-AL. */
  adventureSequential: number;
  /** 1 when this AL stage is part of an on-screen overlap cluster (rendered as
   *  the collapsed pin instead); 0 otherwise and for every non-AL cache. */
  alHidden: number;
}

/** Props for a collapsed Adventure Lab pin (one per on-screen overlap cluster). */
interface AlAdventureProps {
  /** Representative adventure id (the cluster's first member); "" if absent. */
  adventureId: string;
  /** Number of stages merged into this pin (shown as the badge). */
  count: number;
  /** 1 when any member stage is in the Cluster-Lab selection. */
  selected: number;
  /** Comma-joined member cache ids, for modifier-click whole-adventure toggle. */
  memberIds: string;
  color: string;
  /** 1 when EVERY member stage is found — dim the pin like a found cache. */
  foundByMe: number;
}

const SELECTED_LAYER = "gctp-caches-selected";

export interface SelectedParking {
  point: [number, number];
  ownerCacheId: number;
}

export interface CachesLayerProps {
  /**
   * Canonical, debounced caches-query input owned by App. Used as both the
   * React Query key and the fetch args so this layer and App share one
   * query/cache entry. ALL filters are server-side now (FR-SF10), so this is
   * the single source of what renders — there's no client-side narrowing.
   */
  queryInput: ListCachesParams;
  /**
   * Extra caches to render unconditionally, unioned (by id) with the query
   * result. Used when opening a saved tour: the stored plan's denormalised
   * cache snapshots are shown even though they fall outside the current
   * radius query (or no longer exist in the caches table — FR-P1.3).
   */
  extraCaches?: readonly CacheSummaryDTO[];
  /** Manual selection from the Cluster Lab — drives the highlight ring. */
  selectedCacheIds?: ReadonlySet<number>;
  /** Shift-click toggles a cache in/out of the selection. */
  onSelectionChange?: (next: ReadonlySet<number>) => void;
  /**
   * Clicking a parking marker reports it here so the parent can render the
   * owner-cache link line. `null` clears the selection (used when the
   * caller wants to deselect on outside click).
   */
  onParkingSelect?: (next: SelectedParking | null) => void;
  /**
   * Connectivity, so the in-popup mark-found / clear-solved writes disable
   * offline. Passed (not read via `useOnline`) because the popup is built
   * imperatively inside a map event handler; a ref keeps the live value
   * readable from that long-lived closure.
   */
  online?: boolean;
  /**
   * When a plan is shown, why each dropped cache was left out — keyed by cache
   * id. Threaded into the single cache popup so a click shows cache details AND
   * the drop reason (no separate popup competes for the gray "×" marker).
   */
  droppedById?: ReadonlyMap<number, Tours.DroppedCache>;
}

export function CachesLayer({
  queryInput,
  extraCaches,
  selectedCacheIds,
  onSelectionChange,
  onParkingSelect,
  online = true,
  droppedById,
}: CachesLayerProps): null {
  const { map, ready } = useMap();
  const queryClient = useQueryClient();
  // The click→popup handler is bound once; read connectivity through a ref so it
  // always sees the current value without rebinding the whole layer effect.
  const onlineRef = useRef(online);
  onlineRef.current = online;
  // Same rationale: the popup is built in a long-lived handler closure, so read
  // the live drop-reason map through a ref instead of rebinding the layer.
  const droppedByIdRef = useRef(droppedById);
  droppedByIdRef.current = droppedById;

  // Latest rendered caches, for the popup's Adventure-Lab completion rollup
  // (FR-I19) — the click handler can't see `renderCaches`'s local `caches`.
  const cachesRef = useRef<readonly CacheSummaryDTO[]>([]);
  // Screen point of the last pointer-down, used to tell a tap from a pan so a
  // pan that happens to end on a marker doesn't open its popup. See the click
  // handlers below and ./pointer-drag.
  const downPointRef = useRef<{ x: number; y: number } | null>(null);
  const query = useQuery({
    queryKey: ["caches", queryInput],
    queryFn: ({ signal }) => listCaches(queryInput, signal),
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    if (!ready) return;

    // FR-SF2 + FR-SF6 + FR-SF9 are now ALL server-side filters (see
    // CachesQuery): the cache pool the planner clusters must equal the set
    // shown on the map, so every filter lives in one place — the server
    // query — and the map just renders whatever `/caches` returned. No
    // client-side narrowing here anymore.
    // Union the radius query with any explicit extras (saved-tour snapshots),
    // query data winning on id collisions (it carries the full live fields).
    const caches = mergeCachesById(query.data?.caches, extraCaches) ?? [];
    cachesRef.current = caches;

    // Parking waypoints (static; not zoom-dependent).
    const parkingFeatures: GeoJSON.Feature<
      GeoJSON.Point,
      { cacheCode: string; cacheId: number }
    >[] = [];
    for (const c of caches) {
      for (const [lng, lat] of c.parkingPoints) {
        parkingFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lng, lat] },
          properties: { cacheCode: c.code, cacheId: c.id },
        });
      }
    }
    upsertGeoJsonSource(map, PARKING_SOURCE, parkingFeatures);
    // The cache + collapsed-AL sources are (re)populated by renderCaches() below
    // — it recomputes the AL pixel-collapse for the current zoom. Seed them empty
    // so the layers can attach before the first render.
    if (!map.getSource(CACHES_SOURCE))
      upsertGeoJsonSource(map, CACHES_SOURCE, []);
    if (!map.getSource(AL_ADVENTURES_SOURCE))
      upsertGeoJsonSource(map, AL_ADVENTURES_SOURCE, []);

    if (!map.getLayer(CACHES_CIRCLE_LAYER)) {
      map.addLayer({
        id: CACHES_CIRCLE_LAYER,
        type: "circle",
        source: CACHES_SOURCE,
        // Non-AL caches only; Adventure Lab stages render via CACHES_AL_CIRCLE_LAYER
        // (un-collapsed stages) or the collapsed AL pin (FR-I17).
        filter: ["==", ["get", "stageSequence"], 0],
        paint: CACHE_CIRCLE_PAINT,
      });
    }
    // Individual Adventure Lab stage circles. `alHidden` is set per-render by
    // renderCaches() for stages that are part of an on-screen overlap cluster
    // (shown as the collapsed pin instead); the rest render like regular caches
    // (purple via the `color` prop) and separate out as the user zooms in.
    if (!map.getLayer(CACHES_AL_CIRCLE_LAYER)) {
      map.addLayer({
        id: CACHES_AL_CIRCLE_LAYER,
        type: "circle",
        source: CACHES_SOURCE,
        filter: [
          "all",
          [">", ["get", "stageSequence"], 0],
          ["==", ["get", "alHidden"], 0],
        ],
        paint: AL_CIRCLE_PAINT,
      });
    }
    // Invisible hit target (see CACHES_HIT_LAYER comment). Covers regular caches
    // AND exploded AL stages (anything not collapsed into a pin: alHidden==0);
    // the collapsed AL pin keeps its own handler. Radius ≥ the largest visible
    // marker (cache 9, AL 8) and the cluster-emphasis marker (9), with a touch
    // of fat-finger margin.
    if (!map.getLayer(CACHES_HIT_LAYER)) {
      map.addLayer({
        id: CACHES_HIT_LAYER,
        type: "circle",
        source: CACHES_SOURCE,
        filter: ["==", ["get", "alHidden"], 0],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 14],
          "circle-color": "#000000",
          "circle-opacity": 0,
        },
      });
    }
    // "Z" overlay on disabled caches — matches the visual language
    // geocaching.com uses (zzz = sleeping). Plain ASCII so it
    // renders in every glyph source. Only shown when the marker is
    // big enough for the letter to read (≥ zoom 11).
    if (!map.getLayer(CACHES_DISABLED_LABEL_LAYER)) {
      map.addLayer({
        id: CACHES_DISABLED_LABEL_LAYER,
        type: "symbol",
        source: CACHES_SOURCE,
        minzoom: 11,
        // Skip AL stages collapsed into a pin (their circle is hidden).
        filter: [
          "all",
          ["==", ["get", "disabled"], 1],
          ["!=", ["get", "alHidden"], 1],
        ],
        layout: {
          "text-field": "Z",
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 8, 14, 12],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-anchor": "center",
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "#000000",
          "text-halo-width": 1.4,
        },
      });
    }
    // Solved-coordinate cue: a small green checkmark badge on the upper-right
    // of caches whose plotted location is the user's solved/corrected
    // coordinate (Mystery solution or Multi final) — same idea as the tour
    // stop's green "T" tool badge, distinct from the red Cluster-Lab selection
    // ring. The icon is a canvas image (see ensureSolvedBadgeIcon) so it
    // doesn't depend on the glyph source's symbol range.
    if (
      ensureSolvedBadgeIcon(map) &&
      !map.getLayer(CACHES_SOLVED_BADGE_LAYER)
    ) {
      map.addLayer({
        id: CACHES_SOLVED_BADGE_LAYER,
        type: "symbol",
        source: CACHES_SOURCE,
        filter: [
          "all",
          ["==", ["get", "solved"], 1],
          ["!=", ["get", "alHidden"], 1],
        ],
        layout: {
          "icon-image": SOLVED_BADGE_ICON,
          // upper-right of the marker; offset is in the 24px icon space and
          // then scaled by icon-size.
          "icon-offset": [11, -11],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 14, 0.7],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    }
    // Adventure Lab stage number, drawn ON the marker as "S1", "S2", … . The
    // "S" prefix is deliberate: the tour overlay (TourLayer) labels routed stops
    // with bare numbers (1, 2, 3…), so prefixing keeps stage numbers from being
    // read as stop order. `stageSequence` is 0 for non-AL caches, so `> 0` both
    // scopes this to lab stages and skips AL rows imported before stage metadata.
    if (!map.getLayer(CACHES_AL_STAGE_LABEL_LAYER)) {
      map.addLayer({
        id: CACHES_AL_STAGE_LABEL_LAYER,
        type: "symbol",
        source: CACHES_SOURCE,
        // The S{n} label is only legible once zoomed in; keep a floor so it
        // doesn't clutter at low zoom, and skip stages collapsed into a pin.
        minzoom: AL_STAGE_LABEL_MINZOOM,
        filter: [
          "all",
          [">", ["get", "stageSequence"], 0],
          ["==", ["get", "alHidden"], 0],
          // Linear adventures get the distinct corner badge below instead.
          ["!=", ["get", "adventureSequential"], 1],
        ],
        layout: {
          "text-field": [
            "concat",
            "S",
            ["to-string", ["get", "stageSequence"]],
          ],
          "text-font": ["Noto Sans Bold"],
          // Slightly smaller so the "S{n}" sits within the (small) AL circle
          // rather than overflowing it.
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 7, 14, 10],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-anchor": "center",
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "#7b1fa2",
          "text-halo-width": 1.6,
          // Dim a completed (found) stage's label with its circle.
          "text-opacity": FOUND_DISABLED_OPACITY,
        },
      });
    }
    // Linear AL stages (FR-I18): the stage number at the pin's top-right, drawn
    // like the tool-cache "T" badge — a haloed glyph with NO background bubble
    // (text-offset in ems puts it in the corner; the purple halo carries it over
    // the marker). Moved to the very top of the style after setup so the cluster
    // -emphasis discs can't hide it.
    if (!map.getLayer(CACHES_AL_LINEAR_BADGE_LABEL_LAYER)) {
      map.addLayer({
        id: CACHES_AL_LINEAR_BADGE_LABEL_LAYER,
        type: "symbol",
        source: CACHES_SOURCE,
        minzoom: AL_STAGE_LABEL_MINZOOM,
        filter: [
          "all",
          [">", ["get", "stageSequence"], 0],
          ["==", ["get", "alHidden"], 0],
          ["==", ["get", "adventureSequential"], 1],
        ],
        layout: {
          "text-field": ["to-string", ["get", "stageSequence"]],
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 9, 14, 12],
          // Top-right corner, like the tool "T" badge (ems, not pixels).
          "text-offset": [0.8, -0.8],
          "text-anchor": "center",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "#7b1fa2",
          "text-halo-width": 2,
          // Dim the number with a completed (found) stage.
          "text-opacity": FOUND_DISABLED_OPACITY,
        },
      });
    }
    // Collapsed Adventure Lab pin — one purple disc per on-screen overlap
    // cluster of stages (populated by renderCaches). A red ring marks a cluster
    // with any selected stage (mirrors SELECTED_LAYER).
    if (!map.getLayer(AL_ADVENTURE_CIRCLE_LAYER)) {
      map.addLayer({
        id: AL_ADVENTURE_CIRCLE_LAYER,
        type: "circle",
        source: AL_ADVENTURES_SOURCE,
        paint: {
          // Slightly SMALLER than a regular cache (which is z9→4, z14→9) so a
          // collapsed adventure reads as "a cache, plus more behind it" rather
          // than dominating the overview.
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3, 14, 8],
          "circle-color": ["get", "color"],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "selected"], 1],
            "#ff1744",
            "#ffffff",
          ],
          "circle-stroke-width": [
            "case",
            ["==", ["get", "selected"], 1],
            3,
            1.5,
          ],
          "circle-opacity": FOUND_DISABLED_OPACITY,
          "circle-stroke-opacity": FOUND_DISABLED_OPACITY,
        },
      });
    }
    // Stage count badge on the collapsed pin, so a multi-stage adventure is
    // visibly a group rather than a lone cache.
    if (!map.getLayer(AL_ADVENTURE_COUNT_LAYER)) {
      map.addLayer({
        id: AL_ADVENTURE_COUNT_LAYER,
        type: "symbol",
        source: AL_ADVENTURES_SOURCE,
        // Only legible once the pin is big enough; below that the purple disc
        // alone signals "Adventure Lab here".
        minzoom: AL_STAGE_LABEL_MINZOOM,
        layout: {
          // "×N" — matches the planned tour's collapsed-stop label.
          "text-field": ["concat", "×", ["to-string", ["get", "count"]]],
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 9, 14, 11],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-anchor": "center",
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "#7b1fa2",
          "text-halo-width": 1.6,
          "text-opacity": FOUND_DISABLED_OPACITY,
        },
      });
    }
    if (!map.getLayer(PARKING_LAYER)) {
      map.addLayer({
        id: PARKING_LAYER,
        type: "circle",
        source: PARKING_SOURCE,
        // Cache-owner parking waypoints aren't useful below city-block
        // zoom — they overlap the cache they belong to and just add
        // visual noise. PARKING_MIN_ZOOM is shared with OsmParkingLayer
        // so the two layers always pop in together.
        minzoom: PARKING_MIN_ZOOM,
        paint: {
          // Sized smaller than the cache circle at every zoom so the
          // cache stays the headline feature. Cache layer interpolates
          // z9→4 / z14→9; parking goes PARKING_MIN_ZOOM→3 / +3→6.
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            PARKING_MIN_ZOOM,
            3,
            PARKING_MIN_ZOOM + 3,
            6,
          ],
          "circle-color": "#ffffff",
          "circle-stroke-color": "#1565c0",
          // Stroke also tapers so a small radius doesn't look like a
          // doughnut at city zoom.
          "circle-stroke-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            PARKING_MIN_ZOOM,
            1,
            PARKING_MIN_ZOOM + 3,
            1.8,
          ],
        },
      });
    }
    // Halo ring for any cache shift-clicked into the Cluster Lab selection.
    // Non-AL only — a selected AL stage that's collapsed into a pin would ring a
    // hidden circle, so AL gets the dedicated `alHidden`-gated ring below, while
    // the collapsed pin shows its own ring when any member is selected.
    if (!map.getLayer(SELECTED_LAYER)) {
      map.addLayer({
        id: SELECTED_LAYER,
        type: "circle",
        source: CACHES_SOURCE,
        filter: [
          "all",
          ["==", ["get", "selected"], 1],
          ["==", ["get", "stageSequence"], 0],
        ],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 8, 14, 14],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#ff1744",
          "circle-stroke-width": 3,
        },
      });
    }
    // Selection ring for individual (un-collapsed) AL stages. Collapsed ones
    // show their selection via the pin's ring instead.
    if (!map.getLayer(SELECTED_AL_STAGE_LAYER)) {
      map.addLayer({
        id: SELECTED_AL_STAGE_LAYER,
        type: "circle",
        source: CACHES_SOURCE,
        filter: [
          "all",
          ["==", ["get", "selected"], 1],
          [">", ["get", "stageSequence"], 0],
          ["==", ["get", "alHidden"], 0],
        ],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 8, 14, 14],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#ff1744",
          "circle-stroke-width": 3,
        },
      });
    }

    // Keep the linear-stage number on top of everything (incl. the collapsed AL
    // pins, selection rings, and ClustersPreviewLayer's emphasis discs) so it's
    // always readable. moveLayer() with no beforeId pops it to the very top.
    if (map.getLayer(CACHES_AL_LINEAR_BADGE_LABEL_LAYER)) {
      map.moveLayer(CACHES_AL_LINEAR_BADGE_LABEL_LAYER);
    }

    // Build the cache features for the current zoom and (re)populate the sources.
    // Adventure Lab stages that overlap on screen collapse into one pin (the same
    // pixel-proximity logic the planned tour uses); non-AL caches are NEVER
    // collapsed, so density/cluster patterns stay readable. Recomputed on zoom so
    // overlapping stages separate as you zoom in. Non-AL never sets alHidden.
    const renderCaches = (): void => {
      const alClusters = clusterByPixelProximity(
        caches
          .filter((c) => c.type === "Adventure Lab")
          .map((c) => ({
            lng: c.location.coordinates[0]!,
            lat: c.location.coordinates[1]!,
            item: c,
          })),
        (lngLat) => map.project(lngLat),
        OVERLAP_PX,
      );
      const hidden = new Set<number>();
      const adventureFeatures: GeoJSON.Feature<
        GeoJSON.Point,
        AlAdventureProps
      >[] = [];
      for (const { members, center } of alClusters) {
        if (members.length < 2) continue; // a lone stage renders individually
        for (const m of members) hidden.add(m.id);
        adventureFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: center },
          properties: {
            adventureId: members[0]!.adventureId ?? "",
            count: members.length,
            selected: members.some((m) => selectedCacheIds?.has(m.id)) ? 1 : 0,
            memberIds: members.map((m) => m.id).join(","),
            color: TYPE_COLORS["Adventure Lab"],
            // Dim the whole collapsed adventure once every stage is found.
            foundByMe: members.every((m) => m.foundByMe) ? 1 : 0,
          },
        });
      }
      const cachesFeatures = caches.map<
        GeoJSON.Feature<GeoJSON.Point, CacheProps>
      >((c) => ({
        type: "Feature",
        id: c.id,
        geometry: c.location,
        properties: {
          id: c.id,
          code: c.code,
          name: c.name,
          type: c.type,
          color: TYPE_COLORS[c.type] ?? TYPE_COLORS.Other,
          foundByMe: c.foundByMe ? 1 : 0,
          selected: selectedCacheIds?.has(c.id) ? 1 : 0,
          disabled: c.disabled ? 1 : 0,
          solved: c.solved ? 1 : 0,
          stageCount: c.stageCount,
          adventureId: c.adventureId ?? null,
          stageSequence: c.stageSequence ?? 0,
          stageTotal: c.stageTotal ?? 0,
          adventureSequential: c.adventureSequential ? 1 : 0,
          alHidden: hidden.has(c.id) ? 1 : 0,
        },
      }));
      upsertGeoJsonSource(map, CACHES_SOURCE, cachesFeatures);
      upsertGeoJsonSource(map, AL_ADVENTURES_SOURCE, adventureFeatures);
      // Some MapLibre builds don't schedule a redraw after setData on an
      // otherwise-idle map (the "caches only appear after I click" symptom).
      map.triggerRepaint();
    };

    renderCaches();
    // Recompute the AL collapse after a zoom settles (cheap; AL subset only).
    map.on("zoomend", renderCaches);
    return () => {
      map.off("zoomend", renderCaches);
    };
  }, [map, ready, query.data, extraCaches, selectedCacheIds]);

  // Click handler — bound once. Reads from current source data, not the
  // closure, so it stays correct as the query refreshes.
  useEffect(() => {
    if (!ready) return;
    const handler = (
      e: maplibregl.MapMouseEvent & {
        features?: maplibregl.MapGeoJSONFeature[];
      },
    ) => {
      // Ignore clicks that are really the tail of a pan — under the reticle
      // model the user pans over caches constantly to reposition the area.
      if (isDragGesture(downPointRef.current, e.point)) return;
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as unknown as CacheProps;
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;

      // Modifier-click → toggle into the Cluster Lab selection set instead
      // of opening the popup. Shift on Linux/Windows; ⌘ or Ctrl on macOS
      // (browsers sometimes hijack plain shift-click for text selection).
      const me = e.originalEvent;
      if (
        onSelectionChange &&
        (me.shiftKey || me.ctrlKey || me.metaKey || me.altKey)
      ) {
        // Stop other layer handlers (and MapView's pick-center) from also
        // running on this click.
        me.preventDefault();
        // Feature properties survive a JSON round-trip through MapLibre, so
        // coerce id to number defensively in case the source-data hop ever
        // changes that.
        const id = Number(props.id);
        const next = new Set(selectedCacheIds ?? []);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        // eslint-disable-next-line no-console
        console.debug(
          "[cluster-lab] toggle",
          id,
          "→ selection size",
          next.size,
        );
        onSelectionChange(next);
        return;
      }

      const container = document.createElement("div");
      const root = createRoot(container);

      const popup = new maplibregl.Popup({ closeButton: true })
        .setLngLat([lng, lat])
        .setDOMContent(container)
        .addTo(map);

      const id = Number(props.id);
      // The lean /caches list omits popup-only fields (difficulty, terrain,
      // attributes, hints); fetch them lazily on open. Header fields come from
      // the summary props so the popup paints instantly, then detail fills in.
      let detail: CacheDTO | null = null;
      let found = props.foundByMe === 1;
      let solved = props.solved === 1;
      // Adventure-Lab completion rollup (FR-I19): how many of this adventure's
      // stages the user has found, for the "not started / partly / done" badge.
      const advId = props.adventureId;
      const advStages = advId
        ? cachesRef.current.filter((c) => c.adventureId === advId)
        : [];
      const adventureStageCount = advId
        ? props.stageTotal || advStages.length
        : 0;
      const adventureFoundCount = advStages.filter((c) => c.foundByMe).length;
      const renderPopup = () => {
        const drop = droppedByIdRef.current?.get(id) ?? null;
        root.render(
          <CachePopup
            code={props.code}
            name={props.name}
            type={props.type}
            difficulty={detail?.difficulty ?? null}
            terrain={detail?.terrain ?? null}
            foundByMe={found}
            attributeIds={detail?.attributeIds ?? []}
            descriptionHints={detail?.descriptionHints ?? []}
            stageCount={props.stageCount}
            adventureId={props.adventureId}
            stageSequence={props.stageSequence || null}
            stageTotal={props.stageTotal || null}
            adventureSequential={props.adventureSequential === 1}
            adventureFoundCount={adventureFoundCount}
            adventureStageCount={adventureStageCount}
            solved={solved}
            loadingDetail={detail === null}
            online={onlineRef.current}
            dropReason={drop?.reason ?? null}
            neededBudgetMeters={drop?.neededBudgetMeters ?? null}
            onToggleFound={async () => {
              if (!onlineRef.current) return;
              try {
                if (found) await unmarkCacheFound(id);
                else await markCacheFound(id);
                found = !found;
                renderPopup();
                void queryClient.invalidateQueries({ queryKey: ["caches"] });
              } catch (err) {
                console.error("toggle found failed", err);
              }
            }}
            onClearSolved={
              solved
                ? async () => {
                    if (!onlineRef.current) return;
                    try {
                      const { cleared } = await clearSolvedCoordinates(id);
                      if (cleared) solved = false;
                      renderPopup();
                      // The cache's location reverted — refetch so the marker
                      // jumps back to the posted coord.
                      void queryClient.invalidateQueries({
                        queryKey: ["caches"],
                      });
                      void queryClient.invalidateQueries({
                        queryKey: ["cache-detail", id],
                      });
                    } catch (err) {
                      console.error("clear solved failed", err);
                    }
                  }
                : undefined
            }
          />,
        );
      };

      renderPopup();
      void queryClient
        .fetchQuery({
          queryKey: ["cache-detail", id],
          queryFn: () => fetchCacheDetail(id),
          gcTime: 60_000,
        })
        .then((d) => {
          detail = d;
          renderPopup();
          // The card just grew (chips). We mutated its DOM via React without
          // telling MapLibre, so its anchor transform was rounded for the old
          // size and the resized card can land on a sub-pixel → blurry text.
          // Re-set the position after React commits (next frame) so MapLibre
          // re-measures and re-rounds the transform for the final size.
          requestAnimationFrame(() => {
            if (popup.isOpen()) popup.setLngLat([lng, lat]);
          });
        })
        .catch((err) => {
          // Leave the header-only popup; detail just won't fill in.
          console.error("cache detail fetch failed", err);
        });

      popup.on("close", () => {
        // Defer to next microtask so React doesn't unmount mid-event.
        queueMicrotask(() => root.unmount());
      });
    };
    const enter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const leave = () => {
      map.getCanvas().style.cursor = "";
    };
    const parkingHandler = (
      e: maplibregl.MapMouseEvent & {
        features?: maplibregl.MapGeoJSONFeature[];
      },
    ) => {
      if (isDragGesture(downPointRef.current, e.point)) return;
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as { cacheCode?: string; cacheId?: number };
      const code = props.cacheCode ?? "?";
      const cacheId = props.cacheId;
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      new maplibregl.Popup({ closeButton: true })
        .setLngLat([lng, lat])
        .setHTML(
          `<div style="font:13px system-ui;padding:2px 4px">Parking for <strong>${code}</strong></div>`,
        )
        .addTo(map);
      // Drive the owner-link layer — every click pins to the latest
      // parking. Clearing happens via the dedicated layer's outside-click
      // handler, keeping this handler simple.
      if (typeof cacheId === "number" && onParkingSelect) {
        onParkingSelect({ point: [lng, lat], ownerCacheId: cacheId });
      }
    };
    // Collapsed Adventure Lab pin: plain click zooms in so the adventure
    // explodes into its stages; a modifier-click toggles the WHOLE adventure
    // in/out of the Cluster-Lab selection at once (FR-I17).
    const collapsedHandler = (
      e: maplibregl.MapMouseEvent & {
        features?: maplibregl.MapGeoJSONFeature[];
      },
    ) => {
      if (isDragGesture(downPointRef.current, e.point)) return;
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as unknown as AlAdventureProps;
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
      const memberIds = String(props.memberIds)
        .split(",")
        .map(Number)
        .filter((n) => Number.isFinite(n));
      const me = e.originalEvent;
      if (
        onSelectionChange &&
        (me.shiftKey || me.ctrlKey || me.metaKey || me.altKey)
      ) {
        me.preventDefault();
        const next = new Set(selectedCacheIds ?? []);
        const allSelected =
          memberIds.length > 0 && memberIds.every((id) => next.has(id));
        for (const id of memberIds) {
          if (allSelected) next.delete(id);
          else next.add(id);
        }
        onSelectionChange(next);
        return;
      }
      // Zoom past the explode threshold, centred on the adventure.
      map.easeTo({
        center: [lng, lat],
        zoom: Math.max(map.getZoom() + 2, AL_EXPLODE_ZOOM + 1),
      });
    };
    // Track the pointer-down screen point map-wide so the layer click handlers
    // can distinguish a tap from a pan that ends on a marker.
    const rememberDown = (
      e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent,
    ) => {
      downPointRef.current = { x: e.point.x, y: e.point.y };
    };
    map.on("mousedown", rememberDown);
    map.on("touchstart", rememberDown);
    // One binding on the invisible hit layer covers regular caches AND exploded
    // AL stages (same popup + selection behaviour); its radius exceeds the
    // visible/emphasis markers so edge taps still register.
    map.on("click", CACHES_HIT_LAYER, handler);
    map.on("mouseenter", CACHES_HIT_LAYER, enter);
    map.on("mouseleave", CACHES_HIT_LAYER, leave);
    map.on("click", AL_ADVENTURE_CIRCLE_LAYER, collapsedHandler);
    map.on("mouseenter", AL_ADVENTURE_CIRCLE_LAYER, enter);
    map.on("mouseleave", AL_ADVENTURE_CIRCLE_LAYER, leave);
    map.on("click", PARKING_LAYER, parkingHandler);
    map.on("mouseenter", PARKING_LAYER, enter);
    map.on("mouseleave", PARKING_LAYER, leave);
    return () => {
      map.off("mousedown", rememberDown);
      map.off("touchstart", rememberDown);
      map.off("click", CACHES_HIT_LAYER, handler);
      map.off("mouseenter", CACHES_HIT_LAYER, enter);
      map.off("mouseleave", CACHES_HIT_LAYER, leave);
      map.off("click", AL_ADVENTURE_CIRCLE_LAYER, collapsedHandler);
      map.off("mouseenter", AL_ADVENTURE_CIRCLE_LAYER, enter);
      map.off("mouseleave", AL_ADVENTURE_CIRCLE_LAYER, leave);
      map.off("click", PARKING_LAYER, parkingHandler);
      map.off("mouseenter", PARKING_LAYER, enter);
      map.off("mouseleave", PARKING_LAYER, leave);
    };
  }, [
    map,
    ready,
    queryClient,
    selectedCacheIds,
    onSelectionChange,
    onParkingSelect,
  ]);

  return null;
}

function upsertGeoJsonSource(
  map: maplibregl.Map,
  id: string,
  features: GeoJSON.Feature[],
): void {
  const collection: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features,
  };
  const existing = map.getSource(id);
  if (existing && "setData" in existing) {
    (existing as maplibregl.GeoJSONSource).setData(collection);
    return;
  }
  map.addSource(id, { type: "geojson", data: collection });
}
