// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { LocationProvider, useLocation } from "./LocationProvider.js";

let successCb: PositionCallback | null = null;
let errorCb: PositionErrorCallback | null = null;
const clearWatch = vi.fn();

function Consumer(): JSX.Element {
  const { status, position, enable } = useLocation();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="pos">{position ? position.join(",") : "none"}</span>
      <button onClick={enable}>enable</button>
    </div>
  );
}

beforeEach(() => {
  successCb = null;
  errorCb = null;
  window.localStorage.clear();
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      watchPosition: (s: PositionCallback, e?: PositionErrorCallback) => {
        successCb = s;
        errorCb = e ?? null;
        return 1;
      },
      clearWatch,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LocationProvider", () => {
  it("watches and surfaces a position fix on enable", () => {
    render(
      <LocationProvider>
        <Consumer />
      </LocationProvider>,
    );
    expect(screen.getByTestId("status").textContent).toBe("off");

    act(() => screen.getByText("enable").click());
    expect(screen.getByTestId("status").textContent).toBe("locating");

    act(() =>
      successCb?.({
        coords: { longitude: 5, latitude: 52, accuracy: 12 },
      } as GeolocationPosition),
    );
    expect(screen.getByTestId("status").textContent).toBe("watching");
    expect(screen.getByTestId("pos").textContent).toBe("5,52");
  });

  it("reports `denied` when permission is refused", () => {
    render(
      <LocationProvider>
        <Consumer />
      </LocationProvider>,
    );
    act(() => screen.getByText("enable").click());
    act(() =>
      errorCb?.({
        code: 1,
        PERMISSION_DENIED: 1,
      } as GeolocationPositionError),
    );
    expect(screen.getByTestId("status").textContent).toBe("denied");
  });

  it("testing mode: reports the tapped point instead of GPS, and survives a reload", () => {
    function Sim(): JSX.Element {
      const l = useLocation();
      return (
        <div>
          <span data-testid="status">{l.status}</span>
          <span data-testid="pos">
            {l.position ? l.position.join(",") : "none"}
          </span>
          <span data-testid="sim">{String(l.simulated)}</span>
          <button onClick={() => l.setSimulated(true)}>sim-on</button>
          <button onClick={() => l.setSimulatedPosition([6, 51])}>tap</button>
          <button onClick={() => l.setSimulated(false)}>sim-off</button>
        </div>
      );
    }
    const tree = (
      <LocationProvider>
        <Sim />
      </LocationProvider>
    );
    const view = render(tree);
    act(() => screen.getByText("sim-on").click());
    expect(screen.getByTestId("status").textContent).toBe("locating");
    act(() => screen.getByText("tap").click());
    expect(screen.getByTestId("pos").textContent).toBe("6,51");
    expect(screen.getByTestId("status").textContent).toBe("watching");
    // GPS fixes don't move a simulated position (no watch runs).
    expect(successCb).toBeNull();

    view.unmount();
    render(tree);
    expect(screen.getByTestId("sim").textContent).toBe("true");
    expect(screen.getByTestId("pos").textContent).toBe("6,51");

    act(() => screen.getByText("sim-off").click());
    expect(screen.getByTestId("sim").textContent).toBe("false");
    expect(screen.getByTestId("pos").textContent).toBe("none");
  });
});
