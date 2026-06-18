// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Screenshot the PWA install/update visual harness (dev/pwa-preview.html) at a
// mobile and a desktop viewport, so layout changes can be eyeballed without a
// device. Requires the web dev server running (pnpm --filter @gctp/web dev).
//
//   node apps/web/scripts/shoot-pwa-preview.mjs
//   PREVIEW_URL=http://localhost:5173 OUT_DIR=/tmp/pwa-shots node apps/web/scripts/shoot-pwa-preview.mjs

import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const base = process.env.PREVIEW_URL ?? "http://localhost:5173";
const url = `${base}/dev/pwa-preview.html`;
const outDir = process.env.OUT_DIR ?? "/tmp/pwa-shots";

const viewports = [
  { name: "mobile-360", width: 360, height: 760 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const vp of viewports) {
    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    await page.goto(url, { waitUntil: "networkidle" });
    const path = `${outDir}/${vp.name}.png`;
    await page.screenshot({ path });
    console.log(`wrote ${path}`);
    await page.close();
  }
} finally {
  await browser.close();
}
