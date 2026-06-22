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
import { OVERLAP_PX } from "./pixel-cluster.js";
import { collapseByProximity } from "./marker-collapse.js";
import {
  TYPE_COLORS,
  TYPE_GLYPH,
  dimOpacityExpression,
  ensureSolvedBadgeIcon,
  SOLVED_BADGE_ICON,
  ensureToolBadgeIcon,
  TOOL_BADGE_ICON,
  ensureMarkerImage,
  markerImageId,
  cornerIconOffset,
  cornerTextOffset,
} from "./marker-style.js";
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
const CACHES_TOOL_BADGE_LAYER = "gctp-caches-tool-badge";
// Unified centre-slot label (ADR-0035): the type letter for a regular cache,
// "S{n}"/"L{n}" stage-id for an AL stage. Driven by the per-feature `centerText`.
const CACHES_CENTER_LABEL_LAYER = "gctp-caches-center-label";
const SELECTED_AL_STAGE_LAYER = "gctp-caches-selected-al-stage";
// Collapsed Adventure Labs (FR-I17): AL stages that overlap on screen collapse
// into one pin (the same pixel-proximity logic the planned tour uses — see
// ./pixel-cluster) and separate back into individual stages as the user zooms in.
// Non-AL caches are never collapsed, so density/cluster patterns stay readable.
const AL_ADVENTURES_SOURCE = "gctp-al-adventures";
const AL_ADVENTURE_CIRCLE_LAYER = "gctp-al-adventure-circle";
const AL_ADVENTURE_SELECTED_LAYER = "gctp-al-adventure-selected";
const AL_ADVENTURE_COUNT_LAYER = "gctp-al-adventure-count";
/** Below this zoom an S{n} stage label / collapsed-pin count is illegible. */
const AL_STAGE_LABEL_MINZOOM = PARKING_MIN_ZOOM;
/** Zoom a collapsed-pin click jumps to, to separate its overlapping stages. */
const AL_EXPLODE_ZOOM = PARKING_MIN_ZOOM;
const PARKING_SOURCE = "gctp-parking";
const PARKING_LAYER = "gctp-parking-circle";

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
  "circle-opacity": dimOpacityExpression(),
  "circle-stroke-opacity": dimOpacityExpression(),
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

/**
 * Adventure-Lab marker SHAPE (ADR-0035): AL stages render as a purple squircle
 * (a generated icon) so kind is distinguishable from a regular cache (circle)
 * without relying on colour — the colour-blind-safe second channel. The image is
 * a single purple squircle (AL is always purple), reused for the individual
 * stage and the collapsed adventure pin. `icon-size` is tuned to match the old
 * AL circle footprint (z9→~6px, z14→~16px diameter).
 */
const AL_COLOR = TYPE_COLORS["Adventure Lab"];
const AL_SQUIRCLE_ICON = markerImageId("al", AL_COLOR);
const AL_ICON_SIZE: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  9,
  0.4,
  14,
  1.05,
];

/**
 * Centre-slot text for a marker (ADR-0035, plain/cluster context): an AL stage
 * shows its identity "S{n}" (random-order) / "L{n}" (linear); a regular cache
 * shows its type letter (the colour-blind-safe redundancy for the type colour).
 * In a tour the centre becomes the visit-order number instead — that's owned by
 * TourLayer, which renders its own stops.
 */
function centerTextFor(c: CacheSummaryDTO): string {
  if ((c.stageSequence ?? 0) > 0) {
    return `${c.adventureSequential ? "L" : "S"}${c.stageSequence}`;
  }
  return TYPE_GLYPH[c.type] ?? TYPE_GLYPH.Other;
}

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
  /** 1 when the cache needs equipment (FR-SF5) — drives the tool wrench badge. */
  hasTool: number;
  /** Centre-slot text (ADR-0035): the type letter for a cache, "S{n}"/"L{n}"
   *  for an AL stage. "" when there's nothing to draw. */
  centerText: string;
  /** 1 when an active tour OWNS this cache (a routed stop or a dropped
   *  candidate). TourLayer draws it instead, so the caches layer hides its
   *  VISIBLE marker (the hit target stays, so the popup still opens). */
  tourOwned: number;
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
  /**
   * Cache ids OWNED by the active tour (routed stops + dropped candidates).
   * Their visible markers are hidden here so TourLayer is the single authority
   * for how a routed/dropped cache looks — no double-draw, no S{n}-over-order
   * bleed. Empty/absent when no tour is shown.
   */
  tourOwnedIds?: ReadonlySet<number>;
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
  tourOwnedIds,
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
        // (un-collapsed stages) or the collapsed AL pin (FR-I17). Tour-owned
        // caches are hidden here — TourLayer draws them.
        filter: [
          "all",
          ["==", ["get", "stageSequence"], 0],
          ["==", ["get", "tourOwned"], 0],
        ],
        paint: CACHE_CIRCLE_PAINT,
      });
    }
    // Individual Adventure Lab stage circles. `alHidden` is set per-render by
    // renderCaches() for stages that are part of an on-screen overlap cluster
    // (shown as the collapsed pin instead); the rest render like regular caches
    // (purple via the `color` prop) and separate out as the user zooms in.
    const alIconOk = ensureMarkerImage(map, "al", AL_COLOR);
    if (!map.getLayer(CACHES_AL_CIRCLE_LAYER)) {
      const alFilter: maplibregl.FilterSpecification = [
        "all",
        [">", ["get", "stageSequence"], 0],
        ["==", ["get", "alHidden"], 0],
        ["==", ["get", "tourOwned"], 0],
      ];
      // Squircle icon when a 2D canvas is available; circle fallback otherwise
      // (jsdom in tests — the icon image can't be generated there).
      map.addLayer(
        alIconOk
          ? {
              id: CACHES_AL_CIRCLE_LAYER,
              type: "symbol",
              source: CACHES_SOURCE,
              filter: alFilter,
              layout: {
                "icon-image": AL_SQUIRCLE_ICON,
                "icon-size": AL_ICON_SIZE,
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              },
              paint: { "icon-opacity": dimOpacityExpression() },
            }
          : {
              id: CACHES_AL_CIRCLE_LAYER,
              type: "circle",
              source: CACHES_SOURCE,
              filter: alFilter,
              paint: AL_CIRCLE_PAINT,
            },
      );
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
          ["==", ["get", "tourOwned"], 0],
        ],
        layout: {
          "text-field": "Z",
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 8, 14, 12],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          // Reserved BL corner so the disabled cue never fights the centre glyph.
          "text-offset": cornerTextOffset("BL"),
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "#000000",
          "text-halo-width": 1.4,
        },
      });
    }
    // Solved-coordinate cue: a small green checkmark badge in the reserved TL
    // corner of caches whose plotted location is the user's solved/corrected
    // coordinate (Mystery solution or Multi final), distinct from the red
    // Cluster-Lab selection ring. The icon is a canvas image (see
    // ensureSolvedBadgeIcon) so it
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
          ["==", ["get", "tourOwned"], 0],
        ],
        layout: {
          "icon-image": SOLVED_BADGE_ICON,
          // Reserved TL corner (icon-space offset, scaled by icon-size).
          "icon-offset": cornerIconOffset("TL"),
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 14, 0.7],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    }
    // Tool-required cue (FR-SF5): a wrench badge in the reserved TR corner of any
    // cache that needs equipment. An ICON (not a "T" letter) deliberately — a "T"
    // would collide with the Traditional type glyph (status = icons, identity =
    // letters). Same canvas-image technique as the solved badge.
    if (ensureToolBadgeIcon(map) && !map.getLayer(CACHES_TOOL_BADGE_LAYER)) {
      map.addLayer({
        id: CACHES_TOOL_BADGE_LAYER,
        type: "symbol",
        source: CACHES_SOURCE,
        filter: [
          "all",
          ["==", ["get", "hasTool"], 1],
          ["!=", ["get", "alHidden"], 1],
          ["==", ["get", "tourOwned"], 0],
        ],
        layout: {
          "icon-image": TOOL_BADGE_ICON,
          "icon-offset": cornerIconOffset("TR"),
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 14, 0.7],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": dimOpacityExpression() },
      });
    }
    // Centre-slot label drawn ON the marker (ADR-0035): the type letter for a
    // regular cache, "S{n}"/"L{n}" for an AL stage (see centerTextFor). The S/L
    // prefix keeps AL stage numbers from being read as tour stop order — the
    // tour overlay (TourLayer) labels routed stops with bare numbers.
    if (!map.getLayer(CACHES_CENTER_LABEL_LAYER)) {
      map.addLayer({
        id: CACHES_CENTER_LABEL_LAYER,
        type: "symbol",
        source: CACHES_SOURCE,
        // Only legible once zoomed in; keep a floor so the letters don't clutter
        // the overview, and skip AL stages collapsed into a pin (empty centre
        // text is also skipped via the filter).
        minzoom: AL_STAGE_LABEL_MINZOOM,
        filter: [
          "all",
          ["==", ["get", "alHidden"], 0],
          ["!=", ["get", "centerText"], ""],
          ["==", ["get", "tourOwned"], 0],
        ],
        layout: {
          "text-field": ["get", "centerText"],
          "text-font": ["Noto Sans Bold"],
          // Small enough to sit within the (small) marker rather than overflow.
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 7, 14, 10],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-anchor": "center",
        },
        paint: {
          // White glyph haloed by the marker's own colour, so it reads on the
          // fill in every context (the colour-blind-safe type/identity cue).
          "text-color": "#ffffff",
          "text-halo-color": ["get", "color"],
          "text-halo-width": 1.6,
          // Dim a completed (found)/disabled marker's label with its base.
          "text-opacity": dimOpacityExpression(),
        },
      });
    }
    // Selection ring for the collapsed pin — a separate circle layer (the
    // squircle icon can't carry a conditional stroke). Drawn before the icon so
    // the icon sits on top; the count label is moved above both further down.
    if (!map.getLayer(AL_ADVENTURE_SELECTED_LAYER)) {
      map.addLayer({
        id: AL_ADVENTURE_SELECTED_LAYER,
        type: "circle",
        source: AL_ADVENTURES_SOURCE,
        filter: ["==", ["get", "selected"], 1],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 7, 14, 12],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#ff1744",
          "circle-stroke-width": 3,
        },
      });
    }
    // Collapsed Adventure Lab pin — one purple SQUIRCLE per on-screen overlap
    // cluster of stages (populated by renderCaches), so a collapsed adventure
    // reads as the same AL shape, "plus more behind it".
    if (!map.getLayer(AL_ADVENTURE_CIRCLE_LAYER)) {
      map.addLayer(
        alIconOk
          ? {
              id: AL_ADVENTURE_CIRCLE_LAYER,
              type: "symbol",
              source: AL_ADVENTURES_SOURCE,
              layout: {
                "icon-image": AL_SQUIRCLE_ICON,
                "icon-size": AL_ICON_SIZE,
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              },
              paint: { "icon-opacity": dimOpacityExpression() },
            }
          : {
              id: AL_ADVENTURE_CIRCLE_LAYER,
              type: "circle",
              source: AL_ADVENTURES_SOURCE,
              paint: {
                "circle-radius": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  9,
                  3,
                  14,
                  8,
                ],
                "circle-color": ["get", "color"],
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 1.5,
                "circle-opacity": dimOpacityExpression(),
                "circle-stroke-opacity": dimOpacityExpression(),
              },
            },
      );
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
          "text-opacity": dimOpacityExpression(),
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
          ["==", ["get", "tourOwned"], 0],
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
          ["==", ["get", "tourOwned"], 0],
        ],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 8, 14, 14],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#ff1744",
          "circle-stroke-width": 3,
        },
      });
    }

    // Keep the AL stage label on top of everything (incl. the collapsed AL pins,
    // selection rings, and ClustersPreviewLayer's emphasis discs) so it stays
    // readable. moveLayer() with no beforeId pops it to the very top.
    if (map.getLayer(CACHES_CENTER_LABEL_LAYER)) {
      map.moveLayer(CACHES_CENTER_LABEL_LAYER);
    }

    // Build the cache features for the current zoom and (re)populate the sources.
    // Adventure Lab stages that overlap on screen collapse into one pin (the same
    // pixel-proximity logic the planned tour uses); non-AL caches are NEVER
    // collapsed, so density/cluster patterns stay readable. Recomputed on zoom so
    // overlapping stages separate as you zoom in. Non-AL never sets alHidden.
    const renderCaches = (): void => {
      // Unified pixel-proximity collapse (shared with the tour's stop collapse):
      // only merged groups (≥2 stages) become a collapsed pin; lone stages render
      // individually via CACHES_AL_CIRCLE_LAYER. `groups` excludes singletons.
      const { groups: alGroups } = collapseByProximity(
        caches
          .filter((c) => c.type === "Adventure Lab")
          .map((c) => ({
            lng: c.location.coordinates[0]!,
            lat: c.location.coordinates[1]!,
            item: c,
          })),
        (lngLat) => map.project(lngLat),
        { thresholdPx: OVERLAP_PX },
      );
      const hidden = new Set<number>();
      const adventureFeatures: GeoJSON.Feature<
        GeoJSON.Point,
        AlAdventureProps
      >[] = [];
      for (const { members, center, count } of alGroups) {
        for (const m of members) hidden.add(m.id);
        adventureFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: center },
          properties: {
            adventureId: members[0]!.adventureId ?? "",
            count,
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
          hasTool: c.requiresTool ? 1 : 0,
          centerText: centerTextFor(c),
          tourOwned: tourOwnedIds?.has(c.id) ? 1 : 0,
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
  }, [map, ready, query.data, extraCaches, selectedCacheIds, tourOwnedIds]);

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
