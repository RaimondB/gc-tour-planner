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
import type { JSX, ReactNode } from "react";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({
    to,
    children,
  }: {
    to: string;
    children: ReactNode;
  }): JSX.Element => <a href={to}>{children}</a>,
}));

// Controllable connectivity.
let mockOnline = true;
vi.mock("../shell/ConnectivityProvider.js", () => ({
  useOnline: () => mockOnline,
}));

// The opened-tour session — assert the page drives it via openTour().
const openTour = vi.fn();
vi.mock("./TourSessionProvider.js", () => ({
  useTourSession: () => ({ openTour }),
}));

// IndexedDB warming — assert prefetch mirrors into it; no-op in the test.
const cacheTourDetail = vi.fn();
const pruneCachedTours = vi.fn();
vi.mock("../../lib/tour-cache.js", () => ({
  cacheTourDetail: (d: unknown) => cacheTourDetail(d),
  pruneCachedTours: (ids: unknown) => pruneCachedTours(ids),
}));

// Controllable current location (default: off → list stays newest-first, no badges).
const mockLocation: {
  position: [number, number] | null;
  accuracyM: number | null;
  status: string;
  enabled: boolean;
  enable: () => void;
  disable: () => void;
} = {
  position: null,
  accuracyM: null,
  status: "off",
  enabled: false,
  enable: vi.fn(),
  disable: vi.fn(),
};
vi.mock("../location/LocationProvider.js", () => ({
  useLocation: () => mockLocation,
}));

const TOUR = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Forest loop",
  cacheCount: 8,
  totalMeters: 5400,
  totalSeconds: 7200,
  createdAt: "2026-06-01T10:00:00.000Z",
  hasPreview: false,
  isShared: false,
  startPoint: { type: "Point", coordinates: [5.12, 52.09] },
};

const listTours = vi.fn();
const getTour = vi.fn();
vi.mock("../../lib/api.js", () => ({
  listTours: () => listTours(),
  getTour: (id: string) => getTour(id),
  deleteTour: vi.fn(),
  renameTour: vi.fn(),
  tourPreviewUrl: (id: string) => `/api/tours/${id}/preview`,
}));

const { MyToursPage } = await import("./MyToursPage.js");

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MyToursPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listTours.mockResolvedValue([TOUR]);
  getTour.mockResolvedValue({ id: TOUR.id });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockOnline = true;
  mockLocation.position = null;
  mockLocation.status = "off";
});

describe("MyToursPage", () => {
  it("keeps Open enabled but disables rename/delete when offline", async () => {
    mockOnline = false;
    renderPage();
    await screen.findByText("Forest loop");

    expect(
      (screen.getByRole("button", { name: "Open" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: /Rename/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /Delete/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // Offline → no cache-warming prefetch.
    expect(getTour).not.toHaveBeenCalled();
  });

  it("opens a tour via the session, then navigates to the planner (no router state)", async () => {
    renderPage();
    await screen.findByText("Forest loop");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(openTour).toHaveBeenCalledWith(TOUR.id);
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("prefetches listed tours into IndexedDB while online", async () => {
    renderPage();
    await screen.findByText("Forest loop");
    await waitFor(() => expect(getTour).toHaveBeenCalledWith(TOUR.id));
    await waitFor(() =>
      expect(cacheTourDetail).toHaveBeenCalledWith({ id: TOUR.id }),
    );
    expect(pruneCachedTours).toHaveBeenCalledWith([TOUR.id]);
  });

  it("shows distance badges and re-sorts nearest when location is on", async () => {
    const near = {
      ...TOUR,
      id: "22222222-2222-2222-2222-222222222222",
      name: "Near loop",
      startPoint: { type: "Point", coordinates: [5.0, 52.0] },
    };
    const far = {
      ...TOUR,
      id: "33333333-3333-3333-3333-333333333333",
      name: "Far loop",
      startPoint: { type: "Point", coordinates: [6.0, 52.0] },
    };
    // Server order is newest-first: Far then Near.
    listTours.mockResolvedValue([far, near]);
    mockLocation.position = [5.0, 52.0];
    mockLocation.status = "watching";

    renderPage();
    await screen.findByText("Far loop");

    // A distance-from-me badge renders for each tour.
    expect(screen.getAllByText(/away/).length).toBeGreaterThan(0);

    // Default keeps server order (Far first); "Nearest" puts Near on top.
    fireEvent.click(screen.getByRole("button", { name: /Nearest/ }));
    const names = Array.from(
      document.querySelectorAll(".tours-list__name"),
    ).map((n) => n.textContent);
    expect(names[0]).toBe("Near loop");
  });
});
