// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "smoke-pq.gpx");

/**
 * Map + cluster + plan smoke for the frontend-majors cluster (ADR-0019:
 * React 19 / Vite 8 / maplibre-gl 5). typecheck can't see maplibre-5 runtime
 * regressions — removed/renamed APIs throw in the browser — so this is the
 * real gate for the bump. It drives the four paths the cluster most endangers:
 * the MapLibre canvas, "Discover clusters" (which had zero e2e and is the exact
 * flow that broke in the zod-4 cluster), cluster focus, and a planned loop.
 *
 * Runs against the dev stack (`pnpm dev`, web :5173 → api :3030); point it
 * elsewhere with `E2E_BASE_URL`.
 */

/**
 * Fail the test if MapLibre (or any app code) throws at runtime. This is what
 * catches a maplibre-5 break that typecheck and the prod build both miss.
 * Network noise (map tiles, OSRM, /api fetches that can be flaky in a sandboxed
 * run) is filtered out — we only care about real JS errors.
 */
function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (
      /Failed to load resource|net::ERR|favicon|\btile\b|osrm|\/api\//i.test(
        text,
      )
    ) {
      return;
    }
    errors.push(`console.error: ${text}`);
  });
  return errors;
}

test("map renders (MapLibre 5) with OSM attribution", async ({ page }) => {
  const errors = collectRuntimeErrors(page);

  await page.goto("/");

  // The map mounts into <div className="map-view"> and MapLibre paints into a
  // .maplibregl-canvas. If maplibre 5 threw on init, the canvas never appears.
  await expect(page.locator(".map-view")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 15_000,
  });

  // OSM attribution is a hard rule on every map view (CLAUDE.md / ADR-0003).
  await expect(
    page.getByRole("link", { name: /OpenStreetMap/ }).first(),
  ).toBeVisible();

  expect(errors, errors.join("\n")).toEqual([]);
});

test("upload → discover clusters → focus → plan a loop", async ({ page }) => {
  const errors = collectRuntimeErrors(page);

  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 15_000,
  });

  // --- precondition: caches must exist before Discover does anything ---
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.locator(".dropzone__success")).toContainText("3 caches", {
    timeout: 15_000,
  });

  // The journey rail's "Pick a cluster" step unlocks once caches exist.
  const clustersChip = page.getByRole("button", { name: /Pick a cluster/ });
  await expect(clustersChip).toBeEnabled({ timeout: 15_000 });
  await clustersChip.click();

  // Scope sidebar interactions to the command-panel body — the peek shares the
  // "Discover clusters" label, so an unscoped getByRole would be ambiguous.
  const sidebar = page.locator(".command-panel__body");

  // The fixture has only 3 caches, but min-cluster-size defaults to 8 — nothing
  // would cluster. Open Advanced settings and drop the slider to its min (2) via
  // Home. The three caches sit ~700 m apart, inside the 1500 m default link gap.
  await sidebar.getByText("Advanced cluster settings").click();
  await sidebar
    .getByRole("slider", { name: /Min caches per cluster/ })
    .press("Home");

  // --- Discover clusters ---
  await sidebar.getByRole("button", { name: "Discover clusters" }).click();

  const clusterRows = page.locator("li.cluster");
  await expect(page.locator(".cluster-picker")).toBeVisible({
    timeout: 30_000,
  });
  await expect(clusterRows.first()).toBeVisible();
  expect(await clusterRows.count()).toBeGreaterThan(0);

  // --- cluster focus: hovering a row adds the "focused" modifier and brightens
  //     the centroid/polyline on the ClustersPreviewLayer (maplibre paint) ---
  const firstRow = clusterRows.first();
  await firstRow.hover();
  await expect(firstRow).toHaveClass(/focused/);

  // --- plan a loop: tapping the row frames + picks the cluster; the peek's
  //     "Plan cluster #N" button then routes it (→ Plan & export step) ---
  await firstRow.locator(".cluster-row-main").click();
  const planButton = page.getByRole("button", { name: /Plan cluster #/ });
  await expect(planButton).toBeVisible({ timeout: 10_000 });
  await planButton.click();

  // The TourLayer renders the routed loop on the map and the sidebar shows the
  // "Planned loop" summary — the end-to-end render the cluster most endangers.
  await expect(page.getByRole("heading", { name: "Planned loop" })).toBeVisible(
    { timeout: 60_000 },
  );

  expect(errors, errors.join("\n")).toEqual([]);
});
