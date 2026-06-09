// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pixel distance between a pointer-down and the matching pointer-up beyond
 * which a gesture counts as a pan (drag) rather than a tap/click. MapLibre's
 * own click-vs-drag threshold is tiny, so a short pan that ends on a feature
 * still fires `click` — which, under the reticle model where the user pans
 * constantly over cache markers, would pop a cache on nearly every pan.
 */
export const DRAG_CLICK_THRESHOLD_PX = 6;

interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * True when the up-point moved far enough from the down-point that the gesture
 * should be treated as a pan, not a click. A null down-point (no tracked
 * pointer-down) is treated as a click so behaviour degrades safely.
 */
export function isDragGesture(
  down: ScreenPoint | null,
  up: ScreenPoint,
  threshold: number = DRAG_CLICK_THRESHOLD_PX,
): boolean {
  if (!down) return false;
  return Math.hypot(up.x - down.x, up.y - down.y) > threshold;
}
