// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Serial: every spec drives the SAME backend DB (upload the fixture, discover
  // clusters). Running them in parallel races on that shared state (e.g. an
  // upload from one spec flips another's dropzone to "Already uploaded"
  // mid-assertion). The whole map suite runs in ~10s serially anyway.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
