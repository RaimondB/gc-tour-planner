// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX } from "react";
import { RouteProfileSettings } from "@gctp/shared/route-profiles";
import type { WalkReplanInput } from "@gctp/shared/walks";

const replanWalk = vi.fn();
const markCacheFound = vi.fn();
vi.mock("../../lib/api.js", () => ({
  ApiError: class extends Error {},
  replanWalk: (input: WalkReplanInput) => replanWalk(input),
  markCacheFound: (id: number) => markCacheFound(id),
}));

let mockOnline = true;
vi.mock("../shell/ConnectivityProvider.js", () => ({
  useOnline: () => mockOnline,
}));
let mockUser: { id: string } | null = { id: "u1" };
vi.mock("../auth/AuthProvider.js", () => ({
  useAuth: () => ({ user: mockUser }),
}));
let mockPosition: [number, number] | null = [5.12, 52.09];
vi.mock("../location/LocationProvider.js", () => ({
  useLocation: () => ({
    position: mockPosition,
    accuracyM: 10,
    enabled: true,
    enable: () => {},
  }),
}));

let stored: unknown = null;
const saveWalk = vi.fn((s: unknown) => {
  stored = s;
  return Promise.resolve();
});
vi.mock("./walk-store.js", () => ({
  saveWalk: (s: unknown) => saveWalk(s),
  loadWalk: () => Promise.resolve(stored),
  clearWalk: () => {
    stored = null;
    return Promise.resolve();
  },
}));

const { WalkSessionProvider, useWalk } = await import(
  "./WalkSessionProvider.js"
);

const STOP = {
  cacheId: 7,
  code: "GC7",
  name: "Seven",
  type: "Traditional" as const,
  location: [5.121, 52.091] as [number, number],
  arriveAt: "2026-11-17T10:10:00.000Z",
  leaveAt: "2026-11-17T10:15:00.000Z",
};
const PLAN = {
  feasible: true,
  kept: "new",
  reason: "",
  order: [STOP],
  returnAt: "2026-11-17T10:30:00.000Z",
  leaveLastBy: "2026-11-17T11:30:00.000Z",
  slackMinutes: 60,
  minutesToReturn: 0,
  geometry: null,
  nextLeg: null,
  candidates: 1,
};

function Harness(): JSX.Element {
  const w = useWalk();
  return (
    <div>
      <span data-testid="hydrated">{String(w.hydrated)}</span>
      <span data-testid="active">{w.session ? "yes" : "no"}</span>
      <span data-testid="stops">{w.session?.plan?.order.length ?? -1}</span>
      <span data-testid="log">
        {w.session?.log.map((l) => l.outcome).join(",")}
      </span>
      <span data-testid="finds">{w.session?.pendingFinds.join(",")}</span>
      <span data-testid="pending">{String(w.session?.pendingStart)}</span>
      <span data-testid="track">{w.session?.track.length ?? -1}</span>
      <button
        onClick={() =>
          w.start({
            profileId: "p1",
            profileName: "Test",
            profile: RouteProfileSettings.parse({}),
            deadline: new Date(Date.now() + 2 * 3_600_000),
            durationMinutes: 120,
            startPoint: [5.12, 52.09],
            returnPoint: [5.12, 52.09],
          })
        }
      >
        start
      </button>
      <button
        onClick={() =>
          w.start({
            profileId: "p1",
            profileName: "Test",
            profile: RouteProfileSettings.parse({}),
            deadline: new Date(Date.now() + 3_600_000),
            durationMinutes: 60,
            startPoint: [5.2, 52.09],
            returnPoint: [5.2, 52.09],
          })
        }
      >
        start-away
      </button>
      <button onClick={() => w.log(7, "found")}>found</button>
      <button onClick={() => w.end()}>end</button>
      <button onClick={() => w.replanNow()}>replan</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <WalkSessionProvider>
        <Harness />
      </WalkSessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  stored = null;
  mockOnline = true;
  mockUser = { id: "u1" };
  mockPosition = [5.12, 52.09];
  replanWalk.mockReset().mockResolvedValue(PLAN);
  markCacheFound.mockReset().mockResolvedValue({ created: true });
  saveWalk.mockClear();
});
afterEach(cleanup);

describe("WalkSessionProvider (FR-T18)", () => {
  it("starts a walk: persisted at once, then planned from here", async () => {
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("hydrated").textContent).toBe("true"),
    );
    fireEvent.click(screen.getByText("start"));
    expect(saveWalk).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("stops").textContent).toBe("1"),
    );
    const input = replanWalk.mock.calls[0]![0] as WalkReplanInput;
    expect(input.position).toEqual([5.12, 52.09]);
    expect(input.returnPoint).toEqual([5.12, 52.09]);
    expect(input.visitedIds).toEqual([]);
  });

  it("logs Found, sends it as visited on the next replan, and marks it found", async () => {
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("hydrated").textContent).toBe("true"),
    );
    fireEvent.click(screen.getByText("start"));
    await waitFor(() =>
      expect(screen.getByTestId("stops").textContent).toBe("1"),
    );
    fireEvent.click(screen.getByText("found"));
    await waitFor(() => expect(replanWalk).toHaveBeenCalledTimes(2));
    expect(
      (replanWalk.mock.calls[1]![0] as WalkReplanInput).visitedIds,
    ).toEqual([7]);
    await waitFor(() => expect(markCacheFound).toHaveBeenCalledWith(7));
    await waitFor(() =>
      expect(screen.getByTestId("finds").textContent).toBe(""),
    );
  });

  it("queues Found while offline and sends it once back online", async () => {
    const view = renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("hydrated").textContent).toBe("true"),
    );
    fireEvent.click(screen.getByText("start"));
    await waitFor(() =>
      expect(screen.getByTestId("stops").textContent).toBe("1"),
    );
    mockOnline = false;
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <WalkSessionProvider>
          <Harness />
        </WalkSessionProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("found"));
    expect(screen.getByTestId("finds").textContent).toBe("7");
    expect(markCacheFound).not.toHaveBeenCalled();
    mockOnline = true;
    await act(async () => {
      view.rerender(
        <QueryClientProvider client={new QueryClient()}>
          <WalkSessionProvider>
            <Harness />
          </WalkSessionProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(markCacheFound).toHaveBeenCalledWith(7));
  });

  it("resumes a stored walk after a reload", async () => {
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("hydrated").textContent).toBe("true"),
    );
    fireEvent.click(screen.getByText("start"));
    await waitFor(() =>
      expect(screen.getByTestId("stops").textContent).toBe("1"),
    );
    cleanup();
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("active").textContent).toBe("yes"),
    );
    expect(screen.getByTestId("stops").textContent).toBe("1");
  });

  it("drops the walk when the user signs out", async () => {
    const view = renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("hydrated").textContent).toBe("true"),
    );
    fireEvent.click(screen.getByText("start"));
    await waitFor(() =>
      expect(screen.getByTestId("active").textContent).toBe("yes"),
    );
    mockUser = null;
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <WalkSessionProvider>
          <Harness />
        </WalkSessionProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("active").textContent).toBe("no"),
    );
    expect(stored).toBeNull();
  });

  it("starting from a map point: plans from there, tracks nothing until arrival", async () => {
    const view = renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("hydrated").textContent).toBe("true"),
    );
    fireEvent.click(screen.getByText("start-away"));
    await waitFor(() => expect(replanWalk).toHaveBeenCalled());
    const input = replanWalk.mock.calls[0]![0] as WalkReplanInput;
    expect(input.position).toEqual([5.2, 52.09]);
    expect(screen.getByTestId("pending").textContent).toBe("true");
    expect(screen.getByTestId("track").textContent).toBe("0");

    // Arrive at the start point → the walk starts.
    mockPosition = [5.2001, 52.0901];
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <WalkSessionProvider>
          <Harness />
        </WalkSessionProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("pending").textContent).toBe("false"),
    );
  });

  it("a manual Replan plans fresh: it doesn't ask to keep the current route", async () => {
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("hydrated").textContent).toBe("true"),
    );
    fireEvent.click(screen.getByText("start"));
    await waitFor(() =>
      expect(screen.getByTestId("stops").textContent).toBe("1"),
    );
    fireEvent.click(screen.getByText("replan"));
    await waitFor(() => expect(replanWalk).toHaveBeenCalledTimes(2));
    expect(
      (replanWalk.mock.calls[1]![0] as WalkReplanInput).previousOrder,
    ).toEqual([]);
  });
});
