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
});
