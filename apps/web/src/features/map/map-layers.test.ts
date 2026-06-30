// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { MAP_LAYER_ORDER } from "./map-layers.js";

const at = (id: string): number => MAP_LAYER_ORDER.indexOf(id);

describe("MAP_LAYER_ORDER", () => {
  it("has no duplicate layer ids", () => {
    expect(new Set(MAP_LAYER_ORDER).size).toBe(MAP_LAYER_ORDER.length);
  });

  it("stacks the tour above the caches and cluster preview", () => {
    expect(at("gctp-caches-circle")).toBeLessThan(at("gctp-tour-line"));
    expect(at("gctp-cluster-preview-lines")).toBeLessThan(at("gctp-tour-line"));
  });

  it("keeps saved-tour footprints below the caches and the active tour", () => {
    // Footprints are faint background context — below everything interactive.
    expect(at("gctp-saved-tours-line")).toBeLessThan(at("gctp-caches-circle"));
    expect(at("gctp-saved-tours-line")).toBeLessThan(
      at("gctp-cluster-preview-lines"),
    );
    expect(at("gctp-saved-tours-line")).toBeLessThan(at("gctp-tour-line"));
  });

  it("keeps cluster centroids below the tour (context hierarchy)", () => {
    expect(at("gctp-cluster-centroids-circle")).toBeLessThan(
      at("gctp-tour-line"),
    );
  });

  it("draws the centre glyph + badges above the cache base", () => {
    const base = at("gctp-caches-circle");
    for (const id of [
      "gctp-caches-center-label",
      "gctp-caches-tool-badge",
      "gctp-caches-solved-badge",
    ]) {
      expect(at(id)).toBeGreaterThan(base);
    }
  });

  it("makes the cluster emphasis ring sit above the cache base (visible halo)", () => {
    expect(at("gctp-cluster-focus-caches-circle")).toBeGreaterThan(
      at("gctp-caches-circle"),
    );
  });

  it("lets routed stops sit above the skipped (dropped) caches", () => {
    expect(at("gctp-tour-dropped-circle")).toBeLessThan(
      at("gctp-tour-stops-circle"),
    );
  });

  it("puts editing overlays above the routed stops", () => {
    expect(at("gctp-tour-stops-circle")).toBeLessThan(
      at("gctp-leg-via-marker-circle"),
    );
  });
});
