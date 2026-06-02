// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  CLUSTERING_STRATEGIES,
  resolveClusteringStrategy,
} from "./registry.js";

// Guards the pure registry extracted for the worker-thread pipeline (ADR-0014):
// the worker resolves a strategy by NAME (no shared object instance), so the
// name→strategy map and the fallback logic must be correct and import-pure.
describe("clustering registry", () => {
  it("registers all four strategies, each reporting its own name", () => {
    expect(Object.keys(CLUSTERING_STRATEGIES).sort()).toEqual([
      "components",
      "dbscan",
      "hdbscan",
      "louvain",
    ]);
    for (const [name, strat] of Object.entries(CLUSTERING_STRATEGIES)) {
      expect(strat.name).toBe(name);
    }
  });

  it("prefers the request strategy over the env default", () => {
    expect(resolveClusteringStrategy("dbscan", "louvain").name).toBe("dbscan");
  });

  it("falls back to the env default when no request strategy", () => {
    expect(resolveClusteringStrategy(undefined, "hdbscan").name).toBe("hdbscan");
  });

  it("falls back to louvain on an unknown/empty env default", () => {
    expect(resolveClusteringStrategy(undefined, "nonsense").name).toBe(
      "louvain",
    );
    expect(resolveClusteringStrategy(undefined, undefined).name).toBe("louvain");
  });
});
