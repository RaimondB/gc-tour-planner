// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { GpxDownloadToast } from "./GpxDownloadToast.js";
import { emitGpxSaved } from "../../lib/gpx-saved-events.js";

afterEach(cleanup);

describe("GpxDownloadToast", () => {
  it("is hidden until a save is emitted, then names the file", () => {
    const { container } = render(<GpxDownloadToast />);
    expect(container.firstChild).toBeNull();

    act(() => emitGpxSaved("gctp-8.3km-12c-Jun17-track.gpx"));

    expect(screen.getByRole("status").textContent).toContain(
      "gctp-8.3km-12c-Jun17-track.gpx",
    );
  });

  it("is a pure confirmation — no open/share action, only dismiss", () => {
    render(<GpxDownloadToast />);
    act(() => emitGpxSaved("tour.gpx"));

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Dismiss");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("dismisses on the dismiss button", () => {
    render(<GpxDownloadToast />);
    act(() => emitGpxSaved("tour.gpx"));
    expect(screen.queryByRole("status")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
