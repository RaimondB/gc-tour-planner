// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AboutDialog } from "./AboutDialog.js";

afterEach(cleanup);

describe("AboutDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <AboutDialog open={false} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("surfaces the injected build stamp and environment when open", () => {
    render(<AboutDialog open onClose={() => {}} />);

    expect(screen.getByRole("dialog", { name: /about this app/i })).toBeTruthy();
    // The build time is the whole point — it must be shown as a <time> carrying
    // the exact injected ISO value so a stale installed PWA is detectable.
    const stamp = document.querySelector("time");
    expect(stamp?.getAttribute("dateTime")).toBe("2026-01-01T00:00:00.000Z");
    // VITE_APP_ENV is unset under test → resolves to UAT.
    expect(screen.getByText("UAT")).toBeTruthy();
  });

  it("closes on the close button", () => {
    const onClose = vi.fn();
    render(<AboutDialog open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
