// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX } from "react";

// getTour drives the online path; control resolve/reject per test.
const getTour = vi.fn();
vi.mock("../../lib/api.js", () => ({ getTour: (id: string) => getTour(id) }));

// Connectivity + auth are read for the error copy and the logout-clear.
let mockOnline = true;
vi.mock("../shell/ConnectivityProvider.js", () => ({
  useOnline: () => mockOnline,
}));
let mockAuthStatus: "pending" | "authenticated" | "unauthenticated" =
  "authenticated";
vi.mock("../auth/AuthProvider.js", () => ({
  useAuth: () => ({ status: mockAuthStatus }),
}));

// The durable store is mocked — its real IndexedDB behaviour is verified in the
// browser. `readCachedTourDetail` is the offline fallback source.
const cacheTourDetail = vi.fn();
const readCachedTourDetail = vi.fn();
const pruneCachedTours = vi.fn();
vi.mock("../../lib/tour-cache.js", () => ({
  cacheTourDetail: (d: unknown) => cacheTourDetail(d),
  readCachedTourDetail: (id: string) => readCachedTourDetail(id),
  pruneCachedTours: (ids: unknown) => pruneCachedTours(ids),
}));

function detail(id: string, hasPreview = false) {
  return {
    id,
    name: id,
    totalMeters: 1,
    totalSeconds: 1,
    cacheCount: 1,
    isShared: false,
    hasPreview,
    createdAt: "2026-06-01T00:00:00.000Z",
    startPoint: { type: "Point", coordinates: [0, 0] },
    parkingPoint: null,
    plan: {
      orderedCacheIds: [1],
      droppedCacheIds: [],
      polyline: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      totals: { meters: 1, seconds: 1, visitMinutes: 0 },
      parking: { point: { type: "Point", coordinates: [0, 0] } },
      scoreBreakdown: {},
      legs: [],
      caches: [
        {
          id: 1,
          code: "GC1",
          type: "Traditional",
          name: "c",
          location: { type: "Point", coordinates: [0, 0] },
        },
      ],
    },
  };
}

const { TourSessionProvider, useTourSession } = await import(
  "./TourSessionProvider.js"
);

function Harness(): JSX.Element {
  const s = useTourSession();
  return (
    <div>
      <span data-testid="id">{s.openTourId ?? ""}</span>
      <span data-testid="plan">{s.planResult ? "plan" : "none"}</span>
      <span data-testid="caches">{s.tourCaches?.length ?? -1}</span>
      <span data-testid="preview">
        {String(s.openedTour?.hasPreview ?? "none")}
      </span>
      <span data-testid="err">{s.error ?? ""}</span>
      <button onClick={() => s.openTour("t1")}>open</button>
      <button onClick={() => s.closeTour()}>close</button>
      <button onClick={() => s.markPreviewCaptured("t1")}>mark</button>
    </div>
  );
}

function renderProvider() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TourSessionProvider>
        <Harness />
      </TourSessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  readCachedTourDetail.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockOnline = true;
  mockAuthStatus = "authenticated";
});

describe("TourSessionProvider", () => {
  it("opens a tour: persists the id and derives plan/caches/preview", async () => {
    getTour.mockResolvedValue(detail("t1"));
    renderProvider();
    fireEvent.click(screen.getByText("open"));

    expect(localStorage.getItem("gctp:opened-tour-id")).toBe('"t1"');
    await waitFor(() =>
      expect(screen.getByTestId("plan").textContent).toBe("plan"),
    );
    expect(screen.getByTestId("caches").textContent).toBe("1");
    expect(cacheTourDetail).toHaveBeenCalled(); // mirrored to the durable store
  });

  it("resumes the persisted tour on mount", async () => {
    localStorage.setItem("gctp:opened-tour-id", '"t1"');
    getTour.mockResolvedValue(detail("t1"));
    renderProvider();
    await waitFor(() => expect(getTour).toHaveBeenCalledWith("t1"));
    await waitFor(() =>
      expect(screen.getByTestId("plan").textContent).toBe("plan"),
    );
  });

  it("offline open with no cached copy → offline error, id retained", async () => {
    mockOnline = false;
    getTour.mockRejectedValue(new Error("offline"));
    renderProvider();
    fireEvent.click(screen.getByText("open"));
    await waitFor(() =>
      expect(screen.getByTestId("err").textContent).toMatch(
        /available offline/,
      ),
    );
    expect(screen.getByTestId("id").textContent).toBe("t1");
    expect(screen.getByTestId("plan").textContent).toBe("none");
  });

  it("offline open falls back to the IndexedDB copy (no error)", async () => {
    mockOnline = false;
    getTour.mockRejectedValue(new Error("offline"));
    readCachedTourDetail.mockResolvedValue(detail("t1"));
    renderProvider();
    fireEvent.click(screen.getByText("open"));
    await waitFor(() =>
      expect(screen.getByTestId("plan").textContent).toBe("plan"),
    );
    expect(screen.getByTestId("err").textContent).toBe("");
  });

  it("online open failure → generic error", async () => {
    getTour.mockRejectedValue(new Error("boom"));
    renderProvider();
    fireEvent.click(screen.getByText("open"));
    await waitFor(() =>
      expect(screen.getByTestId("err").textContent).toMatch(/Couldn’t open/),
    );
  });

  it("closeTour clears the id and derived values", async () => {
    getTour.mockResolvedValue(detail("t1"));
    renderProvider();
    fireEvent.click(screen.getByText("open"));
    await waitFor(() =>
      expect(screen.getByTestId("plan").textContent).toBe("plan"),
    );
    fireEvent.click(screen.getByText("close"));
    await waitFor(() => expect(screen.getByTestId("id").textContent).toBe(""));
    expect(screen.getByTestId("plan").textContent).toBe("none");
  });

  it("logout clears the persisted id and prunes the store", async () => {
    localStorage.setItem("gctp:opened-tour-id", '"t1"');
    getTour.mockResolvedValue(detail("t1"));
    mockAuthStatus = "unauthenticated";
    renderProvider();
    await waitFor(() =>
      expect(localStorage.getItem("gctp:opened-tour-id")).toBe("null"),
    );
    expect(pruneCachedTours).toHaveBeenCalledWith([]);
  });

  it("markPreviewCaptured flips hasPreview", async () => {
    getTour.mockResolvedValue(detail("t1", false));
    renderProvider();
    fireEvent.click(screen.getByText("open"));
    await waitFor(() =>
      expect(screen.getByTestId("preview").textContent).toBe("false"),
    );
    fireEvent.click(screen.getByText("mark"));
    await waitFor(() =>
      expect(screen.getByTestId("preview").textContent).toBe("true"),
    );
  });

  it("throws when used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Harness />)).toThrow(/TourSessionProvider/);
    spy.mockRestore();
  });
});
