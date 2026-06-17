// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./sw-download.js", () => ({ swDownload: vi.fn() }));
vi.mock("./download-text.js", () => ({ downloadText: vi.fn() }));
vi.mock("./gpx-saved-events.js", () => ({ emitGpxSaved: vi.fn() }));

import { downloadText } from "./download-text.js";
import { emitGpxSaved } from "./gpx-saved-events.js";
import { swDownload } from "./sw-download.js";
import { downloadGpx } from "./gpx-download.js";

const OPTS = {
  text: "<gpx></gpx>",
  filename: "tour.gpx",
  mimeType: "application/gpx+xml",
};

afterEach(() => vi.clearAllMocks());

describe("downloadGpx", () => {
  it("uses the SW download when available, fires the toast with the filename, and does NOT anchor-download", async () => {
    vi.mocked(swDownload).mockResolvedValue(true);

    await downloadGpx(OPTS);

    expect(swDownload).toHaveBeenCalledWith(OPTS);
    expect(emitGpxSaved).toHaveBeenCalledWith("tour.gpx");
    expect(downloadText).not.toHaveBeenCalled();
  });

  it("falls back to the anchor download (no toast) when the SW path is unavailable", async () => {
    vi.mocked(swDownload).mockResolvedValue(false);

    await downloadGpx(OPTS);

    expect(swDownload).toHaveBeenCalledWith(OPTS);
    expect(downloadText).toHaveBeenCalledWith(OPTS);
    expect(emitGpxSaved).not.toHaveBeenCalled();
  });
});
