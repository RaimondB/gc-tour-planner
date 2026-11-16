// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { RouteProfileSettings } from "@gctp/shared/route-profiles";
import { AllSettingsSections } from "./SettingsSections.js";

vi.mock("../../lib/api.js", () => ({
  listLanduseProfiles: vi.fn().mockResolvedValue({ profiles: [] }),
}));

/** Render the full form over a live value; return a getter for the latest. */
function renderForm() {
  let latest = RouteProfileSettings.parse({});
  function Host() {
    const [value, setValue] = useState(latest);
    return (
      <AllSettingsSections
        value={value}
        onChange={(next) => {
          latest = next;
          setValue(next);
        }}
      />
    );
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <div className="sidebar">
        <Host />
      </div>
    </QueryClientProvider>,
  );
  return () => latest;
}

afterEach(cleanup);

describe("AllSettingsSections — the shared planner/profile form", () => {
  it("edits each group of the profile-shaped value", () => {
    const latest = renderForm();

    fireEvent.click(screen.getAllByLabelText("Traditional")[0]!);
    fireEvent.click(screen.getByLabelText("Exclude caches I have found"));
    fireEvent.click(screen.getByLabelText("Limit the time I have"));
    fireEvent.click(
      screen.getByLabelText("Adventure Labs: all stages or none"),
    );
    fireEvent.click(screen.getByLabelText("Public parking lots"));
    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.click(screen.getByLabelText("Leiden (connected)"));

    const s = latest();
    expect(s.filters.types).toEqual(["Traditional"]);
    expect(s.filters.excludeFound).toBe(true);
    expect(s.budget.durationMinutes).toBe(180);
    expect(s.adventures.keepTogether).toBe(false);
    expect(s.parking.startPreference).toBe("osm-parking");
    expect(s.advanced.clusteringStrategy).toBe("leiden");
    // Untouched groups keep their defaults.
    expect(s.time).toEqual(RouteProfileSettings.parse({}).time);
  });

  it("only shows the time-limit sliders while a limit is set", () => {
    renderForm();
    expect(screen.queryByText(/Time available/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Limit the time I have"));
    expect(screen.getByText(/Time available: 3 h/)).toBeTruthy();
  });

  it("sets and clears a per-type visit time", () => {
    const latest = renderForm();
    const multi = screen.getByRole("spinbutton", { name: "Multi" });
    fireEvent.change(multi, { target: { value: "20" } });
    expect(latest().time.visitMinutesByType).toEqual({ Multi: 20 });
    fireEvent.change(multi, { target: { value: "" } });
    expect(latest().time.visitMinutesByType).toEqual({});
  });
});
