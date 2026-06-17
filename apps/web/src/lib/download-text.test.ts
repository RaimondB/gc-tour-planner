// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadText } from "./download-text.js";

const OPTS = {
  text: "<gpx></gpx>",
  filename: "tour.gpx",
  mimeType: "application/gpx+xml",
};

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom implements neither of these; stub so we can observe call timing.
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:mock"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("downloadText", () => {
  it("does NOT revoke the object URL synchronously (would race the download handoff)", () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    downloadText(OPTS);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    // Regression: Edge's Android installed-PWA download silently never surfaced
    // because revoke fired before the async handoff. It must be deferred.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });

  it("keeps the anchor in the DOM until after the click, then cleans it up", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      // At click time the anchor must be live and configured.
      expect(this.isConnected).toBe(true);
      expect(this.getAttribute("download")).toBe("tour.gpx");
      expect(this.href).toBe("blob:mock");
    });

    downloadText(OPTS);
    expect(document.querySelector("a")).not.toBeNull();

    vi.runAllTimers();
    expect(document.querySelector("a")).toBeNull();
  });
});
