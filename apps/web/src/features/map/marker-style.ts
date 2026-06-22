// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type maplibregl from "maplibre-gl";
import type { CacheType } from "@gctp/shared/caches";

/**
 * The single source of truth for how a cache / Adventure-Lab stage is drawn on
 * the map (ADR-0035). The marker model is *compositional*: a marker is a
 * **base** (shape = kind, fill = type colour) + a **centre label** (identity or
 * sequence) + **context rings** (in-cluster / in-tour / selected) + **corner
 * badges** (status flags in reserved slots). Each channel is independent and
 * composes, so the same cache reads identically whether it's plain, in a
 * cluster, or routed in a tour.
 *
 * Colour is never the *only* channel — shape (circle vs squircle) and the inner
 * letter carry identity too, so the palette stays legible for colour-blind
 * users (the warm green/red/orange/brown overlap is covered by letter + shape).
 */

/** The two marker shapes. `cache` → circle, `al` → squircle (rounded square). */
export type MarkerKind = "cache" | "al";

/**
 * Per-type fill colour, preserved across every context (a Mystery stays blue in
 * a tour — context is shown by a ring, never by recolouring the fill). Revised
 * vs the legacy palette (ADR-0035): no Traditional/CITO duplicate, Letterbox no
 * longer collides with the reserved AL purple, only one green survives (the
 * green-dominant basemap blended three), and EarthCache is lifted off near-black.
 */
export const TYPE_COLORS: Record<CacheType, string> = {
  Traditional: "#2e7d32", // green (convention) — relies on the white halo for map contrast
  Multi: "#ef6c00", // orange (was amber #f9a825): contrast on light roads, off green/brown
  Mystery: "#1565c0", // blue
  Letterbox: "#c2185b", // magenta (was purple #6a1b9a): frees the violet zone for AL
  EarthCache: "#795548", // lighter brown (was near-black #4e342e)
  Event: "#d32f2f", // red
  Virtual: "#0097a7", // teal
  Webcam: "#455a64", // slate (was olive #558b2f): removes the 3rd green
  Wherigo: "#283593", // navy
  CITO: "#9e9d24", // olive/lime (was #2e7d32): breaks the Traditional duplicate
  "Adventure Lab": "#7b1fa2", // purple — reserved kind colour; AL also has its own squircle shape
  Other: "#616161", // gray
};

/**
 * Redundant (colour-independent) identity glyph per cache type — a single
 * basic-Latin letter, because the map's glyph source (demotiles) only serves
 * basic-Latin ranges. This is the colour-blind backup for the type colour.
 * Adventure-Lab stages show their stage-id (`S{n}`/`L{n}`) in the centre instead
 * of a type letter, so AL's entry here is only a fallback.
 */
export const TYPE_GLYPH: Record<CacheType, string> = {
  Traditional: "T",
  Multi: "M",
  Mystery: "?",
  Letterbox: "L",
  EarthCache: "E",
  Event: "!",
  Virtual: "V",
  Webcam: "W",
  Wherigo: "G",
  CITO: "C",
  "Adventure Lab": "A",
  Other: "O",
};

/** Tour line / in-tour ring accent (the legacy "every stop is red" colour). */
export const TOUR_ACCENT = "#d84315";
/** Cluster-preview / in-cluster ring accent. */
export const CLUSTER_ACCENT = "#fb923c";
/** Selection (Cluster-Lab shift-click) ring colour. */
export const SELECTION_COLOR = "#ff1744";

/**
 * Two independent dims that compose multiplicatively (applied to a marker's
 * every role so a found/disabled cache recedes as a whole):
 *   * found-by-me → 0.35 (recedes; this is what dims a completed AL stage).
 *   * disabled    → 0.50 (geocaching.com convention for temp-disabled).
 * Both together ≈ 0.18, still visible. Returns a fresh expression each call so
 * callers never share a mutable array.
 */
export function dimOpacityExpression(): maplibregl.ExpressionSpecification {
  return [
    "*",
    ["case", ["==", ["get", "foundByMe"], 1], 0.35, 1],
    ["case", ["==", ["get", "disabled"], 1], 0.5, 1],
  ];
}

/** Reserved corner slots — status adornments live here so they never collide. */
export type CornerSlot = "TL" | "TR" | "BL" | "BR";

/** Unit direction (x right, y down — screen space) for each corner slot. */
export const CORNER_SLOTS: Record<CornerSlot, readonly [number, number]> = {
  TL: [-1, -1],
  TR: [1, -1],
  BL: [-1, 1],
  BR: [1, 1],
};

/** Corner offset for an `icon-offset` (icon-pixel space), e.g. solved/tool icon. */
export function cornerIconOffset(
  slot: CornerSlot,
  magnitude = 11,
): [number, number] {
  const [dx, dy] = CORNER_SLOTS[slot];
  return [dx * magnitude, dy * magnitude];
}

/** Corner offset for a `text-offset` (ems), e.g. the BR demoted-identity badge. */
export function cornerTextOffset(
  slot: CornerSlot,
  magnitude = 0.9,
): [number, number] {
  const [dx, dy] = CORNER_SLOTS[slot];
  return [dx * magnitude, dy * magnitude];
}

/** A context ring drawn *around* the base marker (never changes the fill). */
export interface RingStyle {
  color: string;
  width: number;
  /** Extra radius beyond the base marker so the ring sits outside it. */
  radiusBoost: number;
  /** Dash pattern (line-units) — present only for the "excluded" ring. */
  dash?: [number, number];
}

/**
 * Context rings. `selection` is the strongest (red). `inCluster`/`inTour` are
 * solid membership rings. `excluded` is a DASHED ring marking a planner-dropped
 * candidate — dashed-vs-solid is the non-colour channel that survives CVD.
 */
export const RING_STYLES = {
  selection: { color: SELECTION_COLOR, width: 3, radiusBoost: 4 },
  inCluster: { color: CLUSTER_ACCENT, width: 2.5, radiusBoost: 3 },
  inTour: { color: TOUR_ACCENT, width: 2.5, radiusBoost: 3 },
  excluded: { color: TOUR_ACCENT, width: 2, radiusBoost: 3, dash: [1.5, 1] },
} satisfies Record<string, RingStyle>;

// ---------------------------------------------------------------------------
// Generated marker images (canvas → map.addImage). We can't draw two shapes
// with a circle layer, and SDF icons are monochrome (can't carry shape + fill +
// white stroke). So the base marker is a generated image keyed by (kind,colour)
// — a SMALL, bounded set (~12: 11 cache circle-colours + 1 AL squircle), drawn
// lazily and cached by map.hasImage(). The centre glyph and corner badges are
// SEPARATE layers (so the centre can switch identity↔order by context without
// multiplying the image set). Every factory returns false when no 2D canvas is
// available (jsdom in tests) so callers fall back to the circle layers.
// ---------------------------------------------------------------------------

/** Logical marker image size in px (drawn at pixelRatio 2). */
const MARKER_IMG_SIZE = 36;

/** Stable addImage id for a (kind, colour) base marker. */
export function markerImageId(kind: MarkerKind, color: string): string {
  return `gctp-mk-${kind}-${color.replace("#", "")}`;
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw (once) the base marker for a kind+colour and register it as a map image.
 * `cache` → filled circle; `al` → filled squircle. White 1.5px-equivalent
 * stroke (the universal basemap-separation device). Returns false when no 2D
 * canvas is available so the caller can keep the circle-layer fallback.
 */
export function ensureMarkerImage(
  map: maplibregl.Map,
  kind: MarkerKind,
  color: string,
): boolean {
  const id = markerImageId(kind, color);
  if (map.hasImage(id)) return true;
  const size = MARKER_IMG_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const stroke = 3; // ≈1.5px logical at pixelRatio 2
  const pad = stroke;
  ctx.fillStyle = color;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = stroke;
  if (kind === "al") {
    const side = size - 2 * pad;
    roundedRectPath(ctx, pad, pad, side, side, side * 0.32);
    ctx.fill();
    ctx.stroke();
  } else {
    const r = (size - 2 * pad) / 2;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  map.addImage(id, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
  return true;
}

/** addImage id for the canvas-drawn solved checkmark badge. */
export const SOLVED_BADGE_ICON = "gctp-solved-check";

/**
 * Draw (once) a small green disc with a white checkmark and register it as a
 * map image, so the solved badge is a real checkmark. We can't use a "✓" text
 * glyph: the style's glyph source (demotiles) only serves basic-Latin ranges,
 * so U+2713 would 404 and render nothing. Returns false when no 2D canvas is
 * available (jsdom in tests) so the caller can skip the badge layer.
 */
export function ensureSolvedBadgeIcon(map: maplibregl.Map): boolean {
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

/** addImage id for the dashed "excluded" ring (planner-dropped candidates). */
export const EXCLUDED_RING_ICON = "gctp-excluded-ring";

/**
 * Draw (once) a DASHED red ring on a transparent disc — the "excluded" context
 * marker for a planner-dropped candidate (ADR-0035). Dashed-vs-solid is the
 * non-colour channel that survives colour-blindness (MapLibre circle strokes
 * can't be dashed, so this is an icon overlay). Returns false with no 2D canvas.
 */
export function ensureExcludedRingIcon(map: maplibregl.Map): boolean {
  if (map.hasImage(EXCLUDED_RING_ICON)) return true;
  const size = 40;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const c = size / 2;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = TOUR_ACCENT;
  ctx.beginPath();
  ctx.arc(c, c, c - 3, 0, Math.PI * 2);
  ctx.stroke();
  map.addImage(EXCLUDED_RING_ICON, ctx.getImageData(0, 0, size, size), {
    pixelRatio: 2,
  });
  return true;
}

/** addImage id for the canvas-drawn tool-required wrench badge. */
export const TOOL_BADGE_ICON = "gctp-tool-wrench";

/**
 * Draw (once) a high-contrast disc with a bold white wrench — the tool-required
 * adornment. A wrench ICON (not a "T" letter) deliberately: a "T" would collide
 * with the Traditional type glyph (status = icons, identity = letters). The disc
 * is CHARCOAL, not green: a green badge blended into the green basemap and into
 * green caches. The wrench is drawn large and thick so it reads at badge size.
 * Returns false when no 2D canvas is available so the caller can skip the layer.
 */
export function ensureToolBadgeIcon(map: maplibregl.Map): boolean {
  if (map.hasImage(TOOL_BADGE_ICON)) return true;
  const size = 30;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const c = size / 2;
  ctx.beginPath();
  ctx.arc(c, c, c - 1.5, 0, Math.PI * 2);
  ctx.fillStyle = "#263238"; // charcoal — high contrast on green map AND green caches
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  // Bold white wrench filling most of the disc: a thick diagonal handle with an
  // open-jaw "C" head (the gap faces up-right, reading as a spanner).
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = size * 0.16;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath(); // handle
  ctx.moveTo(size * 0.34, size * 0.72);
  ctx.lineTo(size * 0.58, size * 0.46);
  ctx.stroke();
  ctx.beginPath(); // open-jaw head
  ctx.arc(size * 0.62, size * 0.4, size * 0.18, Math.PI * 0.55, Math.PI * 1.95);
  ctx.stroke();
  map.addImage(TOOL_BADGE_ICON, ctx.getImageData(0, 0, size, size), {
    pixelRatio: 2,
  });
  return true;
}

/** addImage id for a mixed-type "stack" pie disc (collapsed tour stops). */
export function pieImageId(colors: readonly string[]): string {
  return `gctp-pie-${colors.map((x) => x.replace("#", "")).join("-")}`;
}

/**
 * Draw (once) a disc split into equal wedges, one per DISTINCT member type
 * colour — so a collapsed stack of different cache types shows the mix at a
 * glance (a single flat colour hid it). A homogeneous stack is a solid disc, so
 * it looks unchanged. Keyed by the (caller-sorted) colour list so each distinct
 * mix is generated once. Returns false with no 2D canvas.
 */
export function ensurePieIcon(
  map: maplibregl.Map,
  colors: readonly string[],
): boolean {
  const id = pieImageId(colors);
  if (map.hasImage(id)) return true;
  const size = 44;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const c = size / 2;
  const r = c - 3;
  if (colors.length <= 1) {
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fillStyle = colors[0] ?? "#616161";
    ctx.fill();
  } else {
    const seg = (Math.PI * 2) / colors.length;
    let a = -Math.PI / 2;
    for (const col of colors) {
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, r, a, a + seg);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      a += seg;
    }
  }
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  map.addImage(id, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
  return true;
}
