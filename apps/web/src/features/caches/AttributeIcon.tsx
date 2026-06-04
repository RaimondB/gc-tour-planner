// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tiny inline-SVG icon set for cache-attribute chips (FR-SF3, FR-SF4)
 * and description-hint chips (FR-SF8). We deliberately don't import a
 * font (Material Symbols / Lucide) — the web bundle stays lean and
 * the chips render even on the first paint before any font is loaded.
 *
 * Each icon is a 24×24 SVG with `fill="currentColor"` so the chip's
 * surrounding CSS color flows through. Unknown `iconKey` values fall
 * back to a generic question-mark chip, which keeps the popup tidy
 * even when the curated lookup misses an attribute id.
 */

interface IconProps {
  iconKey: string;
  title?: string;
}

const ICON_PATHS: Record<string, string> = {
  // ── Tools ────────────────────────────────────────────────────────
  climbing: "M12 2 L4 22 L20 22 Z",
  boat: "M3 16 H21 L19 20 H5 Z M12 4 L12 14 M8 14 H16",
  scuba:
    "M12 2 A4 4 0 1 0 12 10 A4 4 0 1 0 12 2 M8 12 H16 V16 H8 Z M10 16 L8 22 M14 16 L16 22",
  waves:
    "M2 8 Q6 4 12 8 T22 8 M2 14 Q6 10 12 14 T22 14 M2 20 Q6 16 12 20 T22 20",
  flashlight: "M9 2 H15 V8 L13 22 H11 L9 8 Z",
  uv: "M4 4 L8 16 H10 L12 6 L14 16 H16 L20 4 M6 20 H18",
  snow: "M12 2 V22 M3 7 L21 17 M3 17 L21 7 M9 5 L12 2 L15 5 M9 19 L12 22 L15 19",
  ski: "M5 21 L19 3 M3 21 H21",
  tool: "M14 4 L20 10 L13 17 L9 13 L6 16 L4 18 L7 21 L3 21 L3 17 L5 15 L8 12 L12 8 Z",
  tree: "M12 2 L6 12 H9 L5 18 H10 V22 H14 V18 H19 L15 12 H18 Z",
  // ── Common non-tool ─────────────────────────────────────────────
  pets: "M5 9 A2 2 0 1 0 5 5 M19 9 A2 2 0 1 0 19 5 M8 14 A2 2 0 1 0 8 10 M16 14 A2 2 0 1 0 16 10 M12 22 C8 22 6 19 6 16 H18 C18 19 16 22 12 22 Z",
  child:
    "M12 5 A2 2 0 1 0 12 1 A2 2 0 1 0 12 5 M9 8 H15 V14 H13 V22 H11 V14 H9 Z",
  wheelchair:
    "M7 4 A2 2 0 1 0 7 0 A2 2 0 1 0 7 4 M6 6 V14 H14 L17 22 L19 21 L16 12 H8 V6 Z M7 16 A4 4 0 1 0 11 20",
  parking:
    "M7 4 H14 A4 4 0 1 1 14 12 H10 V20 H7 Z M10 7 H14 A1 1 0 1 1 14 9 H10 Z",
  restroom:
    "M8 6 A2 2 0 1 0 8 2 A2 2 0 1 0 8 6 M6 8 H10 V14 H8 V22 H8 V14 H6 Z M16 6 A2 2 0 1 0 16 2 A2 2 0 1 0 16 6 M14 8 L13 14 H15 V22 H17 V14 H19 L18 8 Z",
  water_drop: "M12 2 C7 9 5 13 5 16 A7 7 0 1 0 19 16 C19 13 17 9 12 2 Z",
  picnic:
    "M6 4 L4 14 L6 14 L7 10 L17 10 L18 14 L20 14 L18 4 Z M5 18 L19 18 L17 22 L15 22 L13 18 L11 18 L9 22 L7 22 Z",
  tent: "M3 20 L12 4 L21 20 Z M9 20 V14 L12 11 L15 14 V20",
  bike: "M5 18 A4 4 0 1 0 5 10 A4 4 0 1 0 5 18 M19 18 A4 4 0 1 0 19 10 A4 4 0 1 0 19 18 M5 14 L9 8 L14 8 L19 14 M9 8 L11 4",
  motorcycle:
    "M5 18 A3 3 0 1 0 5 12 A3 3 0 1 0 5 18 M19 18 A3 3 0 1 0 19 12 A3 3 0 1 0 19 18 M7 14 L12 8 L17 8 L19 14",
  vehicle:
    "M3 16 V12 L6 6 H18 L21 12 V16 H18 V18 H15 V16 H9 V18 H6 V16 Z M6 14 H8 M16 14 H18",
  horse:
    "M3 12 L7 10 L8 6 L12 8 L17 8 L21 12 L18 18 L15 18 V14 L13 14 L13 18 L10 18 L10 14 L6 16 Z",
  campfire:
    "M12 2 C14 6 16 8 16 12 A4 4 0 1 1 8 12 C8 8 10 6 12 2 Z M4 20 L20 20 M6 18 L18 22 M18 18 L6 22",
  stealth:
    "M12 12 A5 5 0 1 0 12 2 A5 5 0 1 0 12 12 M4 22 C4 17 8 14 12 14 C16 14 20 17 20 22 M9 8 H11 V10 H9 Z",
  stroller:
    "M5 18 A2 2 0 1 0 5 14 A2 2 0 1 0 5 18 M17 18 A2 2 0 1 0 17 14 A2 2 0 1 0 17 18 M4 16 L19 6 L21 6 L21 4 H17 L4 16 M6 14 L18 6",
  build:
    "M14 4 L20 10 L13 17 L9 13 L6 16 L4 18 L7 21 L3 21 L3 17 L5 15 L8 12 L12 8 Z",
  warning: "M12 2 L22 22 L2 22 Z M11 9 V14 H13 V9 Z M11 16 V18 H13 V16 Z",
  bug: "M9 2 L12 5 L15 2 M6 8 H18 V14 A6 6 0 1 1 6 14 Z M2 10 H6 M18 10 H22 M2 14 H6 M18 14 H22 M2 18 L6 18 M18 18 L22 18",
  payments: "M3 6 H21 V18 H3 Z M12 9 A3 3 0 1 0 12 15 A3 3 0 1 0 12 9",
  landscape: "M3 18 L8 10 L12 14 L16 8 L21 18 Z",
  terrain: "M3 20 L9 8 L13 14 L17 6 L21 20 Z",
  clock: "M12 22 A10 10 0 1 0 12 2 A10 10 0 1 0 12 22 M12 7 V12 L16 14",
  moon: "M20 14 A8 8 0 1 1 10 4 A6 6 0 1 0 20 14 Z",
  calendar: "M5 4 H19 V20 H5 Z M3 8 H21 M8 2 V6 M16 2 V6",
  phone:
    "M5 4 H10 L12 9 L9 11 C10 14 12 16 15 17 L17 14 L22 16 V20 A2 2 0 0 1 20 22 C10 22 2 14 2 4 A2 2 0 0 1 4 2",
  transit:
    "M6 4 H18 A2 2 0 0 1 20 6 V16 A2 2 0 0 1 18 18 H6 A2 2 0 0 1 4 16 V6 A2 2 0 0 1 6 4 M8 18 L6 22 M16 18 L18 22 M8 14 A1 1 0 1 0 8 12 A1 1 0 1 0 8 14 M16 14 A1 1 0 1 0 16 12 A1 1 0 1 0 16 12",
  puzzle:
    "M9 3 H15 V6 H18 A2 2 0 1 1 18 12 H15 V15 H18 V21 H15 V18 H12 A2 2 0 1 0 12 12 H9 V9 H6 V3 Z",
  hike: "M14 2 A2 2 0 1 0 14 6 A2 2 0 1 0 14 2 M10 22 L12 14 L8 12 L11 6 L14 8 L16 12 L20 14",
  wifi: "M2 10 Q12 0 22 10 M5 13 Q12 6 19 13 M8 16 Q12 12 16 16 M11 19 H13",
  tourist:
    "M12 12 A4 4 0 1 0 12 4 A4 4 0 1 0 12 12 M4 22 C4 16 8 14 12 14 C16 14 20 16 20 22 M16 6 L20 4 V8",
  home: "M3 12 L12 3 L21 12 V20 H14 V14 H10 V20 H3 Z",
  group:
    "M9 9 A3 3 0 1 0 9 3 A3 3 0 1 0 9 9 M3 22 V18 C3 15 6 14 9 14 C12 14 15 15 15 18 V22 Z M17 7 A2 2 0 1 0 17 11 M21 21 V18 C21 16 19 15 17 15",
  tour: "M3 18 L12 4 L21 18 Z M9 16 L12 12 L15 16",
  star: "M12 2 L15 9 L22 10 L17 15 L19 22 L12 18 L5 22 L7 15 L2 10 L9 9 Z",
  // ── Description-hint icons (FR-SF8) ──────────────────────────────
  fishing:
    "M5 22 V12 A3 3 0 0 1 8 9 H10 L18 4 L22 4 L17 13 L12 17 V22 M14 16 L18 18",
  binoculars:
    "M4 8 H8 L9 18 H4 Z M16 8 H20 L20 18 H15 Z M9 10 H15 M9 14 H15 M8 6 H10 M14 6 H16",
  magnet:
    "M6 4 V14 A6 6 0 1 0 18 14 V4 H14 V14 A2 2 0 1 1 10 14 V4 Z M6 4 H10 M14 4 H18",
  tweezers: "M11 2 L13 2 L17 18 H7 Z M11 22 H13",
  ladder: "M6 2 V22 M18 2 V22 M6 6 H18 M6 11 H18 M6 16 H18 M6 21 H18",
  mirror:
    "M8 2 H16 A2 2 0 0 1 18 4 V20 A2 2 0 0 1 16 22 H8 A2 2 0 0 1 6 20 V4 A2 2 0 0 1 8 2 M10 6 L14 18",
};

const FALLBACK_PATH =
  "M12 22 A10 10 0 1 0 12 2 A10 10 0 1 0 12 22 M9 9 A3 3 0 1 1 13 11 V14 H11 M11 17 H13";

export function AttributeIcon({ iconKey, title }: IconProps): JSX.Element {
  const path = ICON_PATHS[iconKey] ?? FALLBACK_PATH;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={path} />
    </svg>
  );
}
