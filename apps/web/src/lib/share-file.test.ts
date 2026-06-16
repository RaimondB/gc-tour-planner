// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the download fallback so we can assert exactly when it's reached without
// touching the DOM/anchor machinery (that's download-text.ts's own concern).
vi.mock("./download-text.js", () => ({ downloadText: vi.fn() }));

import { downloadText } from "./download-text.js";
import { shareOrDownloadGpx } from "./share-file.js";

const downloadMock = vi.mocked(downloadText);

const OPTS = {
  text: "<gpx></gpx>",
  filename: "tour.gpx",
  mimeType: "application/gpx+xml",
  title: "My tour",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("shareOrDownloadGpx", () => {
  it("shares via the native sheet when the platform accepts the file", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { canShare: () => true, share });

    await shareOrDownloadGpx(OPTS);

    expect(share).toHaveBeenCalledTimes(1);
    const arg = share.mock.calls[0]![0] as { files: File[]; title?: string };
    expect(arg.files[0]).toBeInstanceOf(File);
    expect(arg.files[0]!.name).toBe("tour.gpx");
    expect(arg.title).toBe("My tour");
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("falls back to download when canShare rejects the file", async () => {
    const share = vi.fn();
    vi.stubGlobal("navigator", { canShare: () => false, share });

    await shareOrDownloadGpx(OPTS);

    expect(share).not.toHaveBeenCalled();
    expect(downloadMock).toHaveBeenCalledWith({
      text: OPTS.text,
      filename: OPTS.filename,
      mimeType: OPTS.mimeType,
    });
  });

  it("respects a user-cancelled share (AbortError) without downloading", async () => {
    const share = vi
      .fn()
      .mockRejectedValue(new DOMException("cancelled", "AbortError"));
    vi.stubGlobal("navigator", { canShare: () => true, share });

    await shareOrDownloadGpx(OPTS);

    expect(share).toHaveBeenCalledTimes(1);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("falls back to download when share fails for a non-cancel reason", async () => {
    const share = vi.fn().mockRejectedValue(new Error("target refused"));
    vi.stubGlobal("navigator", { canShare: () => true, share });

    await shareOrDownloadGpx(OPTS);

    expect(share).toHaveBeenCalledTimes(1);
    expect(downloadMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to download when Web Share is unavailable (desktop)", async () => {
    vi.stubGlobal("navigator", {});

    await shareOrDownloadGpx(OPTS);

    expect(downloadMock).toHaveBeenCalledTimes(1);
  });
});
