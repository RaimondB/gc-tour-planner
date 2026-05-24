// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{spec,test}.ts", "test/**/*.{spec,test}.ts"],
    environment: "node",
    globals: false,
    pool: "forks",
    // Integration tests boot Testcontainers; allow more time on slow boots.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
