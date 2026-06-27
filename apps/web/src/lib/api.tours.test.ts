// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedTourDetail, SavedTourSummary } from "@gctp/shared/tours";
import {
  deleteTour,
  getSharedTour,
  getTour,
  listTours,
  renameTour,
  saveTour,
  shareTour,
  unshareTour,
  updateTour,
} from "./api.js";

const DETAIL: SavedTourDetail = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Forest loop",
  totalMeters: 1234.5,
  totalSeconds: 678.9,
  cacheCount: 2,
  isShared: false,
  hasPreview: false,
  createdAt: "2026-06-13T12:00:00.000Z",
  startPoint: { type: "Point", coordinates: [5.12, 52.09] },
  parkingPoint: { type: "Point", coordinates: [5.12, 52.09] },
  plan: {
    orderedCacheIds: [1, 2],
    droppedCacheIds: [],
    polyline: {
      type: "LineString",
      coordinates: [
        [5.12, 52.09],
        [5.12, 52.09],
      ],
    },
    totals: { meters: 1234.5, seconds: 678.9, visitMinutes: 10 },
    parking: {
      type: "user",
      point: { type: "Point", coordinates: [5.12, 52.09] },
      reason: "x",
      fallback: false,
    },
    scoreBreakdown: { density: 1 },
    legs: [],
    caches: [
      {
        id: 1,
        code: "GC1",
        type: "Traditional",
        name: "One",
        location: { type: "Point", coordinates: [5.12, 52.09] },
      },
      {
        id: 2,
        code: "GC2",
        type: "Traditional",
        name: "Two",
        location: { type: "Point", coordinates: [5.122, 52.091] },
      },
    ],
  },
};

const SUMMARY: SavedTourSummary = {
  id: DETAIL.id,
  name: DETAIL.name,
  totalMeters: DETAIL.totalMeters,
  totalSeconds: DETAIL.totalSeconds,
  cacheCount: DETAIL.cacheCount,
  isShared: DETAIL.isShared,
  hasPreview: DETAIL.hasPreview,
  startPoint: DETAIL.startPoint,
  createdAt: DETAIL.createdAt,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("saved-tours api client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    document.cookie = "csrf=tok-xyz";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("saveTour POSTs /tours with the CSRF header and parses the detail", async () => {
    fetchMock.mockResolvedValue(jsonResponse(DETAIL, 201));
    const result = await saveTour({ name: "Forest loop", plan: DETAIL.plan });

    expect(result.id).toBe(DETAIL.id);
    expect(result.plan.caches).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/tours");
    expect(init.method).toBe("POST");
    expect((init.headers as Headers).get("X-CSRF-Token")).toBe("tok-xyz");
  });

  it("listTours GETs /tours and parses an array of summaries", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SUMMARY]));
    const list = await listTours();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("Forest loop");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/tours");
  });

  it("getTour GETs /tours/:id", async () => {
    fetchMock.mockResolvedValue(jsonResponse(DETAIL));
    const detail = await getTour(DETAIL.id);
    expect(detail.id).toBe(DETAIL.id);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/tours/${DETAIL.id}`);
  });

  it("renameTour PATCHes /tours/:id with the new name", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...DETAIL, name: "Renamed" }));
    const renamed = await renameTour(DETAIL.id, "Renamed");
    expect(renamed.name).toBe("Renamed");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/tours/${DETAIL.id}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Renamed" });
  });

  it("deleteTour DELETEs /tours/:id", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteTour(DETAIL.id);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/tours/${DETAIL.id}`);
    expect(init.method).toBe("DELETE");
  });

  it("updateTour PUTs /tours/:id with the plan and parses the detail", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...DETAIL, name: "Edited" }));
    const updated = await updateTour(DETAIL.id, {
      name: "Edited",
      plan: DETAIL.plan,
    });
    expect(updated.name).toBe("Edited");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/tours/${DETAIL.id}`);
    expect(init.method).toBe("PUT");
    expect((init.headers as Headers).get("X-CSRF-Token")).toBe("tok-xyz");
  });

  it("shareTour POSTs /tours/:id/share and parses the slug + path", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { slug: "abc23def45ghi67j", path: "/shared/abc23def45ghi67j" },
        201,
      ),
    );
    const res = await shareTour(DETAIL.id);
    expect(res.path).toBe("/shared/abc23def45ghi67j");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/tours/${DETAIL.id}/share`);
    expect(init.method).toBe("POST");
  });

  it("unshareTour DELETEs /tours/:id/share", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await unshareTour(DETAIL.id);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/tours/${DETAIL.id}/share`);
    expect(init.method).toBe("DELETE");
  });

  it("getSharedTour GETs /shared/:slug and parses the public payload", async () => {
    const shared = {
      name: "Forest loop",
      totals: { meters: 1234.5, seconds: 678.9, visitMinutes: 10 },
      polyline: DETAIL.plan.polyline,
      parking: { type: "Point", coordinates: [5.12, 52.09] },
      caches: DETAIL.plan.caches,
    };
    fetchMock.mockResolvedValue(jsonResponse(shared));
    const result = await getSharedTour("abc23def45ghi67j");
    expect(result.name).toBe("Forest loop");
    expect(result.caches).toHaveLength(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/shared/abc23def45ghi67j");
  });
});
