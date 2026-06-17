// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Mirror the build-time `define` from vite.config.ts so components that read
  // the injected build stamp (AboutDialog) don't hit an undefined global.
  define: {
    __APP_BUILD_TIME__: JSON.stringify("2026-01-01T00:00:00.000Z"),
  },
  test: {
    include: ["src/**/*.{spec,test}.{ts,tsx}"],
    environment: "jsdom",
    globals: false,
  },
});
