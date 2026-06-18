// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { PwaInstallProvider, usePwaInstall } from "./PwaInstallProvider.js";

afterEach(cleanup);

/** A `beforeinstallprompt`-shaped event with spy-able prompt/userChoice. */
function makeInstallEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const event = new Event("beforeinstallprompt") as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

/** Surfaces the install state + a button that drives the native prompt. */
function Consumer() {
  const { canInstall, promptInstall } = usePwaInstall();
  return (
    <button type="button" onClick={() => void promptInstall()}>
      {canInstall ? "Install app" : "no-install"}
    </button>
  );
}

describe("PwaInstallProvider", () => {
  beforeEach(() => {
    // jsdom has no matchMedia; default to "not standalone" so the provider arms.
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("is not installable until the browser fires beforeinstallprompt", () => {
    render(
      <PwaInstallProvider>
        <Consumer />
      </PwaInstallProvider>,
    );
    expect(screen.getByRole("button").textContent).toBe("no-install");
  });

  it("becomes installable after beforeinstallprompt and prompts on demand", async () => {
    render(
      <PwaInstallProvider>
        <Consumer />
      </PwaInstallProvider>,
    );

    const event = makeInstallEvent();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(screen.getByRole("button").textContent).toBe("Install app");

    // Driving the affordance fires the native prompt...
    await act(async () => {
      screen.getByRole("button").click();
      await event.userChoice;
    });
    expect(event.prompt).toHaveBeenCalledTimes(1);

    // ...and the single-use event is consumed, so the affordance disappears.
    expect(screen.getByRole("button").textContent).toBe("no-install");
  });

  it("clears installability once the app is installed", () => {
    render(
      <PwaInstallProvider>
        <Consumer />
      </PwaInstallProvider>,
    );
    act(() => {
      window.dispatchEvent(makeInstallEvent());
    });
    expect(screen.getByRole("button").textContent).toBe("Install app");

    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(screen.getByRole("button").textContent).toBe("no-install");
  });

  it("does not arm when already running standalone", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    render(
      <PwaInstallProvider>
        <Consumer />
      </PwaInstallProvider>,
    );
    act(() => {
      window.dispatchEvent(makeInstallEvent());
    });
    expect(screen.getByRole("button").textContent).toBe("no-install");
  });
});
