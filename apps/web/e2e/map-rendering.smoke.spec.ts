// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "smoke-pq.gpx");

/**
 * Map-rendering smoke test (regression cover for ADR-0035). The compositional
 * marker model is heavy on MapLibre expressions + per-feature generated images,
 * and NEITHER typecheck NOR the fake-map unit tests catch an invalid expression
 * — MapLibre only rejects it at runtime (it fires an `error` event and silently
 * skips the layer). That's exactly how the cluster emphasis rings regressed:
 * a `["zoom"]` interpolate nested inside "+" made `addLayer` reject the layer,
 * so the rings never appeared. This test asserts, against the REAL map:
 *   1. no MapLibre `error` events fire while the layers are built, and
 *   2. the key marker layers actually EXIST and render features in each context
 *      (plain caches → discovered cluster → focused cluster).
 *
 * Needs the dev stack with the e2e helper: `VITE_E2E=1 pnpm dev`, which exposes
 * the live map at `window.__gctp.map` and bypasses auth (AUTH_DEV_BYPASS=1).
 */

/** Real JS / MapLibre errors only — filter the network noise the stack emits. */
function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const t = msg.text();
    if (
      /Failed to load resource|net::ERR|favicon|\btile\b|osrm|\/api\//i.test(t)
    )
      return;
    errors.push(`console.error: ${t}`);
  });
  return errors;
}

/** Attach a MapLibre `error` listener that stashes messages on `window`. */
async function hookMapErrors(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).__gctp?.map), null, {
    timeout: 15_000,
  });
  await page.evaluate(() => {
    const w = window as any;
    w.__mapErrors = [];
    w.__gctp.map.on("error", (e: any) =>
      w.__mapErrors.push(String(e?.error?.message ?? e?.error ?? e)),
    );
  });
}

async function mapState(page: Page) {
  return page.evaluate((layerIds: string[]) => {
    const map = (window as any).__gctp?.map;
    if (!map) throw new Error("window.__gctp.map missing — VITE_E2E not set?");
    const out: Record<string, { exists: boolean; rendered: number }> = {};
    for (const id of layerIds) {
      const exists = Boolean(map.getLayer(id));
      out[id] = {
        exists,
        rendered: exists
          ? map.queryRenderedFeatures({ layers: [id] }).length
          : 0,
      };
    }
    return { layers: out, errors: (window as any).__mapErrors ?? [] };
  }, LAYER_IDS);
}

const LAYER_IDS = [
  "gctp-caches-circle",
  "gctp-caches-center-label",
  "gctp-cluster-centroids-circle",
  "gctp-cluster-focus-caches-circle",
  "gctp-cluster-preview-lines",
];

test("map renders caches, then cluster centroids + emphasis rings, with no MapLibre errors", async ({
  page,
}) => {
  const errors = collectRuntimeErrors(page);

  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 15_000,
  });
  await hookMapErrors(page);

  // — Plain caches —
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  // Either a fresh "3 caches" upload or "Already uploaded" (the dev DB may
  // already hold the fixture) — both mean the caches are present.
  await expect(page.locator(".dropzone__success")).toBeVisible({
    timeout: 15_000,
  });
  // The cache base + centre-glyph layers must exist (a broken generated image /
  // expression would leave them missing).
  await expect
    .poll(
      async () => (await mapState(page)).layers["gctp-caches-circle"].exists,
    )
    .toBe(true);

  // — Discover clusters —
  const clustersChip = page.getByRole("button", { name: /Pick a cluster/ });
  await expect(clustersChip).toBeEnabled({ timeout: 15_000 });
  await clustersChip.click();
  const sidebar = page.locator(".command-panel__body");
  await sidebar.getByText("Advanced cluster settings").click();
  await sidebar
    .getByRole("slider", { name: /Min caches per cluster/ })
    .press("Home");
  await sidebar.getByRole("button", { name: "Discover clusters" }).click();

  const clusterRows = page.locator(".cluster-card");
  await expect(clusterRows.first()).toBeVisible({ timeout: 30_000 });

  // The emphasis ring layer MUST exist (the regression: it didn't, because the
  // radius expression was rejected) and render at least one ring.
  await expect
    .poll(
      async () =>
        (await mapState(page)).layers["gctp-cluster-focus-caches-circle"]
          .rendered,
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  // — Focus a cluster (hover) —
  await clusterRows.first().hover();
  await expect(clusterRows.first()).toHaveClass(/focused/);

  const state = await mapState(page);
  expect(state.layers["gctp-cluster-centroids-circle"].exists).toBe(true);
  expect(
    state.layers["gctp-cluster-centroids-circle"].rendered,
  ).toBeGreaterThan(0);
  expect(state.layers["gctp-cluster-focus-caches-circle"].exists).toBe(true);
  expect(
    state.layers["gctp-cluster-focus-caches-circle"].rendered,
  ).toBeGreaterThan(0);

  // No MapLibre style/expression errors, no runtime JS errors.
  expect(state.errors, `MapLibre errors:\n${state.errors.join("\n")}`).toEqual(
    [],
  );
  expect(errors, errors.join("\n")).toEqual([]);
});
