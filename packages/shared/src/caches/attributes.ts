// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Curated Groundspeak attribute lookup (FR-SF3). The ids + human names
 * are empirically verified against a `gunzip | grep` pass over the
 * user's stored Pocket Queries — Groundspeak ships the label inline
 * with every `<groundspeak:attribute>`, so the raw GPX is the source
 * of truth, not external lists (which often disagree on numbering).
 *
 * Coverage: every attribute id observed in real PQs + a few common
 * ones the user is likely to hit later. Unknown ids fall back to a
 * generic chip rather than rendering nothing.
 *
 * The `isTool` flag marks attributes that signal "you need to bring
 * physical equipment beyond a pen + GPS." Tool caches:
 *  - Render an orange chip in the cache popup (FR-SF4).
 *  - Show a green "T" badge on the tour stop marker (FR-SF5).
 *  - Add a configurable visit-time bonus per cache (default +5 min, FR-SF7).
 *  - Can be filtered out via the "Hide tool caches" toggle (FR-SF6).
 *
 * `iconKey` is rendered by the web app's <AttributeIcon> component as
 * an inline SVG (Material Symbols isn't bundled and we won't add a
 * font dependency just for chips). Keys are deliberately generic —
 * one icon may be shared by multiple attributes (e.g. "wading" and
 * "swimming" both use the waves icon).
 */
export interface GcAttribute {
  /** Groundspeak attribute id (positive integer). */
  id: number;
  /** Human-readable label, exactly as Groundspeak's PQ emits it. */
  name: string;
  /** Icon key resolved by the web's `<AttributeIcon>` component. */
  iconKey: string;
  /** When true, this attribute counts toward "needs a tool/equipment". */
  isTool: boolean;
}

/**
 * Curated list. Sorted by id ascending so the lookup-by-id binary
 * search degenerates cleanly to a single map miss when unknown.
 */
export const GC_ATTRIBUTES: readonly GcAttribute[] = [
  { id: 1, name: "Dogs", iconKey: "pets", isTool: false },
  { id: 2, name: "Access/parking fee", iconKey: "payments", isTool: false },
  { id: 3, name: "Climbing gear required", iconKey: "climbing", isTool: true },
  { id: 4, name: "Boat required", iconKey: "boat", isTool: true },
  { id: 5, name: "Scuba gear required", iconKey: "scuba", isTool: true },
  { id: 6, name: "Recommended for kids", iconKey: "child", isTool: false },
  { id: 8, name: "Scenic view", iconKey: "landscape", isTool: false },
  { id: 10, name: "Difficult climb", iconKey: "terrain", isTool: false },
  { id: 11, name: "May require wading", iconKey: "waves", isTool: true },
  { id: 12, name: "May require swimming", iconKey: "waves", isTool: true },
  { id: 13, name: "Available 24/7", iconKey: "clock", isTool: false },
  { id: 14, name: "Recommended at night", iconKey: "moon", isTool: false },
  { id: 15, name: "Available in winter", iconKey: "snow", isTool: false },
  { id: 17, name: "Poisonous plants", iconKey: "warning", isTool: false },
  { id: 18, name: "Dangerous animals", iconKey: "warning", isTool: false },
  { id: 19, name: "Ticks", iconKey: "bug", isTool: false },
  { id: 20, name: "Abandoned mine", iconKey: "warning", isTool: false },
  { id: 21, name: "Cliff/falling rocks", iconKey: "warning", isTool: false },
  { id: 22, name: "Hunting area", iconKey: "warning", isTool: false },
  { id: 23, name: "Dangerous area", iconKey: "warning", isTool: false },
  { id: 24, name: "Wheelchair accessible", iconKey: "wheelchair", isTool: false },
  { id: 25, name: "Parking nearby", iconKey: "parking", isTool: false },
  { id: 26, name: "Public transportation nearby", iconKey: "transit", isTool: false },
  { id: 27, name: "Drinking water nearby", iconKey: "water_drop", isTool: false },
  { id: 28, name: "Public restrooms nearby", iconKey: "restroom", isTool: false },
  { id: 29, name: "Telephone nearby", iconKey: "phone", isTool: false },
  { id: 30, name: "Picnic tables nearby", iconKey: "picnic", isTool: false },
  { id: 31, name: "Camping nearby", iconKey: "tent", isTool: false },
  { id: 32, name: "Bicycles", iconKey: "bike", isTool: false },
  { id: 33, name: "Motorcycles", iconKey: "motorcycle", isTool: false },
  { id: 34, name: "Quads", iconKey: "vehicle", isTool: false },
  { id: 35, name: "Off-road vehicles", iconKey: "vehicle", isTool: false },
  { id: 36, name: "Snowmobiles", iconKey: "vehicle", isTool: false },
  { id: 37, name: "Horses", iconKey: "horse", isTool: false },
  { id: 38, name: "Campfires", iconKey: "campfire", isTool: false },
  { id: 39, name: "Thorns", iconKey: "warning", isTool: false },
  { id: 40, name: "Stealth required", iconKey: "stealth", isTool: false },
  { id: 41, name: "Stroller accessible", iconKey: "stroller", isTool: false },
  { id: 42, name: "Needs maintenance", iconKey: "build", isTool: false },
  { id: 43, name: "Livestock nearby", iconKey: "warning", isTool: false },
  { id: 44, name: "Flashlight required", iconKey: "flashlight", isTool: true },
  { id: 46, name: "Trucks/RVs", iconKey: "vehicle", isTool: false },
  { id: 47, name: "Field puzzle", iconKey: "puzzle", isTool: false },
  { id: 48, name: "UV light required", iconKey: "uv", isTool: true },
  { id: 49, name: "May require snowshoes", iconKey: "snow", isTool: true },
  { id: 50, name: "May require cross country skis", iconKey: "ski", isTool: true },
  { id: 51, name: "Special tool required", iconKey: "tool", isTool: true },
  { id: 52, name: "Night cache", iconKey: "moon", isTool: false },
  { id: 53, name: "Park and grab", iconKey: "parking", isTool: false },
  { id: 54, name: "Abandoned structure", iconKey: "warning", isTool: false },
  { id: 55, name: "Short hike (<1 km)", iconKey: "hike", isTool: false },
  { id: 56, name: "Medium hike (1 km–10 km)", iconKey: "hike", isTool: false },
  { id: 57, name: "Long hike (>10 km)", iconKey: "hike", isTool: false },
  { id: 60, name: "Wireless beacon", iconKey: "wifi", isTool: false },
  { id: 62, name: "Seasonal access", iconKey: "calendar", isTool: false },
  { id: 63, name: "Recommended for tourists", iconKey: "tourist", isTool: false },
  { id: 64, name: "Tree climbing required", iconKey: "tree", isTool: true },
  { id: 65, name: "Yard (private residence)", iconKey: "home", isTool: false },
  { id: 66, name: "Teamwork cache", iconKey: "group", isTool: false },
  { id: 67, name: "GeoTour", iconKey: "tour", isTool: false },
  { id: 69, name: "Bonus cache", iconKey: "star", isTool: false },
];

const ATTRIBUTE_BY_ID: ReadonlyMap<number, GcAttribute> = new Map(
  GC_ATTRIBUTES.map((a) => [a.id, a] as const),
);

/**
 * Set of attribute ids that signal "you need physical equipment."
 * Derived once at module load from `GC_ATTRIBUTES`. The backend
 * planner and the frontend filter/badge/icon all import this same
 * set so the tool definition can never drift between layers.
 */
export const TOOL_ATTRIBUTE_IDS: ReadonlySet<number> = new Set(
  GC_ATTRIBUTES.filter((a) => a.isTool).map((a) => a.id),
);

/**
 * Look up an attribute by id. Returns `undefined` for unknown ids
 * (the web's chip component should render a generic "?" fallback).
 */
export function attributeById(id: number): GcAttribute | undefined {
  return ATTRIBUTE_BY_ID.get(id);
}

/**
 * Multi-cache sub-typing threshold (FR-SF1/F2): caches with 1–2
 * `stages` additional waypoints are "mini-multis" (effectively a
 * single hop after the start coordinate); 3+ are full multis with
 * real legwork.
 */
export const MULTI_MINI_MAX_STAGES = 2;

/**
 * Three-way classifier for Multi caches. Caller must gate on
 * `type === "Multi"` — the classifier itself doesn't know the type.
 *
 *   - `"field-puzzle"` — `stageCount === 0`. The PQ shipped no
 *     `stages` waypoints, which is the strong signal that the
 *     owner expects you to *compute the next coord on-site* via a
 *     field puzzle / formula at the start coord. Planning-wise
 *     these behave nothing like a 1–2 stage mini: same fixed point
 *     on the map but the on-site effort is more like solving a
 *     puzzle than walking to a sub-waypoint.
 *   - `"mini"` — 1..MULTI_MINI_MAX_STAGES stages. Quick hop.
 *   - `"full"` — more stages. Real legwork between sub-waypoints.
 */
export type MultiClass = "field-puzzle" | "mini" | "full";

export function classifyMulti(stageCount: number): MultiClass {
  if (stageCount === 0) return "field-puzzle";
  if (stageCount <= MULTI_MINI_MAX_STAGES) return "mini";
  return "full";
}

/**
 * True when `stageCount` qualifies the cache as a mini-multi
 * (1..MULTI_MINI_MAX_STAGES). Returns false for 0 — those are
 * `field-puzzle` multis (see `classifyMulti`) and must not be
 * bucketed with minis since their on-site effort is qualitatively
 * different. Prefer `classifyMulti` in new code.
 */
export function isMiniMulti(stageCount: number): boolean {
  return classifyMulti(stageCount) === "mini";
}

/**
 * Single source of truth for "this cache needs a tool" — used by the
 * planner (to add the visit-time bonus), the map (to render the green
 * T badge on tour stops), and the filter sidebar (to hide tool
 * caches). Two independent signals are unioned:
 *
 *  - Any positive attribute id in `TOOL_ATTRIBUTE_IDS` (the certain
 *    signal — the cache owner explicitly flagged it).
 *  - Any non-empty `descriptionHints` (the inferred signal — our
 *    multilingual keyword scanner matched something in the cache
 *    description; see `description-hints.ts` for the dictionary).
 *
 * `descriptionHints` is optional so backend code that doesn't yet have
 * the field plumbed (e.g. solver path) can pass just the attribute
 * ids without breakage.
 */
export function hasToolRequirement(
  attributeIds: readonly number[],
  descriptionHints?: readonly string[],
): boolean {
  for (const id of attributeIds) {
    if (TOOL_ATTRIBUTE_IDS.has(id)) return true;
  }
  if (descriptionHints && descriptionHints.length > 0) return true;
  return false;
}
