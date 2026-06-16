// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { JSX } from "react";

// Drive connectivity from a controllable stub instead of the real `/api/health`
// probe (timers + AbortController), so these tests stay deterministic.
let mockOnline = true;
const recheck = vi.fn();
vi.mock("../../lib/use-connectivity.js", () => ({
  useConnectivity: () => ({ online: mockOnline, recheck }),
}));

const { ConnectivityProvider, useOnline, useRecheckConnectivity } =
  await import("./ConnectivityProvider.js");
const { OfflineBadge, OfflineBanner } = await import("./OfflineBadge.js");

function Probe(): JSX.Element {
  return <div data-testid="online">{String(useOnline())}</div>;
}

afterEach(() => {
  cleanup();
  mockOnline = true;
  recheck.mockClear();
});

describe("ConnectivityProvider", () => {
  it("exposes the connectivity value to descendants", () => {
    mockOnline = false;
    render(
      <ConnectivityProvider>
        <Probe />
      </ConnectivityProvider>,
    );
    expect(screen.getByTestId("online").textContent).toBe("false");
  });

  it("exposes recheck", () => {
    const captured: Array<() => void> = [];
    function Grab(): JSX.Element {
      captured.push(useRecheckConnectivity());
      return <div />;
    }
    render(
      <ConnectivityProvider>
        <Grab />
      </ConnectivityProvider>,
    );
    captured[0]!();
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it("throws when useOnline is used outside the provider", () => {
    // Silence React's expected error log for the throwing render.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/ConnectivityProvider/);
    spy.mockRestore();
  });
});

describe("OfflineBadge / OfflineBanner", () => {
  it("render nothing while online", () => {
    mockOnline = true;
    render(
      <ConnectivityProvider>
        <OfflineBadge />
        <OfflineBanner />
      </ConnectivityProvider>,
    );
    expect(screen.queryByText("Offline")).toBeNull();
    expect(screen.queryByText(/You’re offline/)).toBeNull();
  });

  it("surface the offline state when offline", () => {
    mockOnline = false;
    render(
      <ConnectivityProvider>
        <OfflineBadge />
        <OfflineBanner />
      </ConnectivityProvider>,
    );
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText(/You’re offline/)).toBeTruthy();
  });
});
