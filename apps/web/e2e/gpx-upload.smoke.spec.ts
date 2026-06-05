// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "smoke-pq.gpx");

/**
 * Upload smoke for the Nest 11 / Express 5 / multer 2 migration (ADR-0017).
 *
 * The GPX upload is our only multipart route, so it is the one surface that
 * exercises multer 2 end-to-end: browser multipart POST → Express 5 router →
 * `FileInterceptor` (multer 2) buffer → `GpxService.ingest` → DB upsert →
 * `/caches` round-trip → UI. If the framework major broke the file path, this
 * is where it shows. Runs against the dev stack (`pnpm dev`, ports 15432/16379);
 * point it elsewhere with `E2E_BASE_URL`.
 */
test("GPX upload ingests caches and unlocks the Plan tab", async ({ page }) => {
  await page.goto("/");

  // The Filter tab is active on load and renders the upload dropzone, which
  // wraps a hidden <input type=file>. Drive it directly (no real drag-drop).
  await expect(
    page.getByRole("heading", { name: "gc-tour-planner" }),
  ).toBeVisible();
  const planTab = page.getByRole("tab", { name: "Plan" });
  await expect(planTab).toBeDisabled(); // no caches yet → Plan is gated

  await page.locator('input[type="file"]').setInputFiles(FIXTURE);

  // The dropzone swaps to a success summary with the FR-I11 stats. Our fixture
  // has three traditional caches. Assert the total only — re-running the smoke
  // against a warm dev DB upserts the same GC codes, so "new" vs "updated"
  // flips between runs while the total stays 3.
  const summary = page.locator(".dropzone__success");
  await expect(summary).toBeVisible({ timeout: 15_000 });
  await expect(summary).toContainText("3 caches");

  // The uploaded caches round-trip through the /caches query and flip
  // `planTabEnabled` true — the "plan renders" gate for this smoke.
  await expect(planTab).toBeEnabled({ timeout: 15_000 });
});
