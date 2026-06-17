// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { swDownload } from "./sw-download.js";

const OPTS = {
  text: "<gpx></gpx>",
  filename: "gctp-tour-track-2026.gpx",
  mimeType: "application/gpx+xml",
};

let store: Map<string, Response>;
let cacheMock: { put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

function setController(controller: object | null): void {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { controller },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  store = new Map();
  cacheMock = {
    put: vi.fn(async (req: string, res: Response) => void store.set(req, res)),
    delete: vi.fn(async () => true),
  };
  vi.stubGlobal("caches", { open: vi.fn(async () => cacheMock) });
  vi.stubGlobal("crypto", { randomUUID: () => "uuid-1234" });
  setController({});
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("swDownload", () => {
  it("stages the GPX as an attachment Response and points a hidden iframe at it", async () => {
    const ok = await swDownload(OPTS);

    expect(ok).toBe(true);
    expect(caches.open).toHaveBeenCalledWith("gpx-downloads");

    const [path, res] = cacheMock.put.mock.calls[0]! as [string, Response];
    expect(path).toBe("/_gpx/uuid-1234/gctp-tour-track-2026.gpx");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="gctp-tour-track-2026.gpx"',
    );
    expect(res.headers.get("content-type")).toBe("application/gpx+xml");
    expect(await res.text()).toBe(OPTS.text);

    const iframe = document.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("src")).toBe(
      "/_gpx/uuid-1234/gctp-tour-track-2026.gpx",
    );
  });

  it("evicts the staged entry and removes the iframe after the delay", async () => {
    await swDownload(OPTS);
    expect(document.querySelector("iframe")).not.toBeNull();

    await vi.runOnlyPendingTimersAsync();

    expect(cacheMock.delete).toHaveBeenCalledWith(
      "/_gpx/uuid-1234/gctp-tour-track-2026.gpx",
    );
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("returns false (so the caller anchor-downloads) when no SW controls the page", async () => {
    setController(null);
    expect(await swDownload(OPTS)).toBe(false);
    expect(cacheMock.put).not.toHaveBeenCalled();
  });
});
