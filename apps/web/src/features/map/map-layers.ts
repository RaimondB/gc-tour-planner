// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type maplibregl from "maplibre-gl";

/**
 * The ONE declarative z-order for every gctp map layer (ADR-0035). Layer
 * components add their layers whenever their data is ready; this list is the
 * single source of truth for how those layers STACK, replacing the scattered
 * `map.moveLayer(...)` juggling that used to fight across files. Order is
 * bottom → top.
 *
 * The order is deliberately STATIC: the only context-dependent stacking we need
 * is "a tour outranks the cluster preview", and that falls out for free — when
 * no tour is planned the `gctp-tour-*` layers don't exist, so the cluster
 * centroids (listed just below the tour) sit above the caches; once a tour is
 * planned they sit beneath it. The remaining tour-vs-cluster emphasis is done
 * with OPACITY (see ClustersPreviewLayer `deEmphasized`), not z-order.
 *
 * `applyLayerOrder` only moves layers that currently exist, so listing a layer
 * that hasn't been added yet (or was removed) is harmless. Layers not in this
 * list (e.g. the basemap's own layers) sink below all gctp overlays, which is
 * what we want.
 */
export const MAP_LAYER_ORDER: readonly string[] = [
  // — Area / context fills (bottom) —
  "gctp-landuse-fill",
  "gctp-landuse-line",
  "gctp-osm-parking-fill",
  "gctp-osm-parking-line",
  "gctp-osm-parking-point",
  "gctp-osm-parking-label",
  "gctp-radius-line",
  "gctp-search-center-dot",
  "gctp-start-pick-circle",
  "gctp-start-pick-label",

  // — Saved-tour footprints (faint dashed loops, background context) —
  "gctp-saved-tours-line",
  "gctp-saved-tours-hit",

  // — Cluster preview loops (an "area shape" hint, below the caches) —
  "gctp-cluster-preview-lines",

  // — Caches: base shapes —
  "gctp-caches-circle",
  "gctp-caches-al-circle",
  "gctp-caches-hit",
  "gctp-parking-circle",

  // — Collapsed Adventure-Lab pins —
  "gctp-al-adventure-selected",
  "gctp-al-adventure-circle",
  "gctp-al-adventure-count",

  // — Cache selection rings + status badges + centre glyph —
  "gctp-caches-selected",
  "gctp-caches-selected-al-stage",
  "gctp-caches-disabled-label",
  "gctp-caches-solved-badge",
  "gctp-caches-tool-badge",
  "gctp-caches-center-label",

  // — Cluster emphasis: member halos + centroids (above caches, below the tour) —
  "gctp-cluster-focus-caches-circle",
  "gctp-cluster-centroids-circle",
  "gctp-cluster-centroids-label",

  // — Tour: route line + arrows —
  "gctp-tour-halo",
  "gctp-tour-line",
  "gctp-tour-arrows",
  "gctp-tour-parking-leader-line",

  // — Skipped (dropped) caches recede BELOW the routed stops —
  "gctp-tour-dropped-circle",
  "gctp-tour-dropped-al-icon",
  "gctp-tour-dropped-label",

  // — Collapsed stop stacks —
  "gctp-tour-stops-collapsed-shadow",
  "gctp-tour-stops-collapsed-circle",
  "gctp-tour-stops-collapsed-label",

  // — Routed stops (the headline of a planned tour) —
  "gctp-tour-stops-circle",
  "gctp-tour-stops-al-icon",
  "gctp-tour-stops-label",
  "gctp-tour-stops-tool",
  "gctp-tour-stops-identity",

  // — Tour parking pin (above the stops so the "P" stays readable) —
  "gctp-tour-parking-circle",
  "gctp-tour-parking-label",

  // — Editing / preview overlays (above the tour) —
  "gctp-leg-alt-preview-line",
  "gctp-leg-via-live-line-stroke",
  "gctp-leg-via-marker-ring",
  "gctp-leg-via-marker-circle",
  "gctp-parking-preview-line",
  "gctp-parking-preview-hit",
  "gctp-parking-owner-link-line",

  // — Current GPS position (you-are-here) — above the tour so it's always visible —
  "gctp-user-location-accuracy",
  "gctp-user-location-dot",
  // — Follow-mode current-target highlight —
  "gctp-follow-target-ring",

  // — Debug overlays —
  "gctp-walking-graph-edges",
  "gctp-walking-graph-suspicious",
  "gctp-walking-graph-isolated",
  "gctp-walking-graph-hit",
  "gctp-walking-graph-route-line",
  "gctp-test-route-line",

  // — Invisible hit target on top (edit-mode tour-leg clicks) —
  "gctp-tour-hit",
];

/**
 * Enforce {@link MAP_LAYER_ORDER}. Each existing layer is moved to the top in
 * list order, so after the pass the stack matches the list exactly (a layer not
 * yet added is skipped). Idempotent and cheap — every layer component calls this
 * at the end of its setup effect, so whichever ran last leaves the whole stack
 * correctly ordered without any component needing to know about the others.
 */
export function applyLayerOrder(map: maplibregl.Map): void {
  for (const id of MAP_LAYER_ORDER) {
    if (!map.getLayer(id)) continue;
    try {
      // No beforeId → move to the very top; iterating bottom→top yields the
      // list order.
      map.moveLayer(id);
    } catch {
      // A layer can vanish between getLayer and moveLayer if another effect
      // tears it down concurrently — harmless, the next pass re-asserts order.
    }
  }
}
