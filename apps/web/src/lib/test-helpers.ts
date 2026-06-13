// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type maplibregl from "maplibre-gl";

/**
 * E2E test helpers, present ONLY in a Vite **dev-mode** build that also sets
 * `VITE_E2E`. Playwright drives the real UI but can't reach into React/MapLibre
 * internals (the map paints to a WebGL canvas — there are no DOM markers to
 * count). Rather than sprinkle ad-hoc `window.__x = y` hooks through the app,
 * expose a single, explicit, env-gated surface here.
 *
 * Production safety — two independent guarantees, both at compile time:
 *
 *   1. **Not shipped.** The gate folds to the literal `false` in any
 *      `vite build` (production mode → `import.meta.env.DEV === false`), so
 *      esbuild dead-code-eliminates the whole helper body AND the `window`
 *      assignment. Grep a prod `dist/` for `__gctp` — it isn't there.
 *   2. **Can't be re-enabled.** Even if `VITE_E2E=1` leaked into a production
 *      build, the `import.meta.env.DEV` conjunct is still `false`, so the
 *      helper stays disabled. `import.meta.env` is inlined at build time, so
 *      there is no runtime switch an attacker (or a misconfig) could flip.
 *
 * E2E therefore runs against a **dev-mode** server: `VITE_E2E=1 pnpm --filter
 * @gctp/web dev` (baseURL :5173). Add new handles under `window.__gctp`; keep
 * the surface small and documented. See docs/sdlc/testing.md.
 */

declare global {
  interface Window {
    /** Present only in a dev-mode `VITE_E2E` build. Live map, for assertions. */
    __gctp?: { map?: maplibregl.Map };
  }
}

/**
 * True only in a Vite dev-mode build that opted in with `VITE_E2E`. Both
 * conjuncts are compile-time literals, so a production build folds this to
 * `false` and strips every guarded helper from the bundle.
 */
export const E2E_HELPERS_ENABLED =
  import.meta.env.DEV && Boolean(import.meta.env.VITE_E2E);

/** Stash the live map instance for e2e assertions. No-op unless `VITE_E2E`. */
export function exposeMapForE2E(map: maplibregl.Map): void {
  if (!E2E_HELPERS_ENABLED) return;
  window.__gctp = { ...window.__gctp, map };
}
