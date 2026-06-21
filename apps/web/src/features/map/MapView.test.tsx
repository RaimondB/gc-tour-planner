// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";

// A fake MapLibre map mirroring the two traits that matter for these
// regressions:
//  1. `getLayer` dereferences `this.style` — so a nulled style throws exactly
//     like the real `Map.getLayer(id) { return this.style.getLayer(id) }`.
//  2. `remove()` AND a WebGL context loss both null `style` while the map
//     object stays alive (MapLibre's `webglcontextlost` handler runs
//     `this.style.destroy(); this.style = null`).
class FakeMap {
  style: { getLayer: (id: string) => undefined } | null = {
    getLayer: () => undefined,
  };
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  private canvas = document.createElement("canvas");
  constructor(opts: { container: HTMLElement }) {
    void opts;
    // Fire `load` asynchronously like the real map so `ready` flips true.
    queueMicrotask(() => this.fire("load"));
  }
  on(event: string, cb: (...a: unknown[]) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(cb);
    return this;
  }
  off(event: string, cb: (...a: unknown[]) => void): this {
    this.handlers.get(event)?.delete(cb);
    return this;
  }
  fire(event: string): void {
    for (const cb of [...(this.handlers.get(event) ?? [])]) cb({});
  }
  /** Simulate the OS reclaiming the GPU while backgrounded. */
  loseContext(): void {
    this.style = null;
    this.fire("webglcontextlost");
  }
  restoreContext(): void {
    this.style = { getLayer: () => undefined };
    this.fire("webglcontextrestored");
  }
  getLayer(id: string): undefined {
    // Throws "Cannot read properties of null (reading 'getLayer')" when dead.
    return this.style!.getLayer(id);
  }
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
  getCenter(): { lng: number; lat: number } {
    return { lng: 0, lat: 0 };
  }
  getZoom(): number {
    return 11;
  }
  resize(): void {}
  triggerRepaint(): void {}
  queryRenderedFeatures(): unknown[] {
    return [];
  }
  remove(): void {
    this.style = null;
  }
}

let lastMap: FakeMap | null = null;
vi.mock("maplibre-gl", () => ({
  default: {
    Map: function (opts: { container: HTMLElement }): FakeMap {
      const m = new FakeMap(opts);
      lastMap = m;
      return m; // a constructor returning an object makes `new Map()` yield it
    },
  },
}));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

beforeEach(() => {
  lastMap = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Imported AFTER the mock is registered.
const { MapView } = await import("./MapView.js");
const { useMap, isMapStyleLive, MapContext } = await import("./MapContext.js");

/** A layer whose cleanup drops its layer the way the real layers do. */
function LayerWithGetLayerCleanup(): null {
  const { map } = useMap();
  useEffect(() => {
    return () => {
      if (map.getLayer("some-layer")) map.removeLayer?.("some-layer");
    };
  }, [map]);
  return null;
}

/**
 * A realistic layer: every real layer's style-effect opens with `if (!ready)
 * return` and only then touches the map. `tick` stands in for a focus-driven
 * dependency change (e.g. a React Query refetch) that re-runs the effect.
 */
function RealisticLayer({ tick }: { tick: number }): null {
  const { map, ready } = useMap();
  useEffect(() => {
    if (!ready) return;
    map.getLayer("gctp-some-layer");
  }, [map, ready, tick]);
  return null;
}

describe("MapView teardown", () => {
  it("does not crash when a child layer's cleanup touches the map on unmount", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <MapView>
          <LayerWithGetLayerCleanup />
        </MapView>,
      );
      await Promise.resolve();
    });
    expect(() => {
      act(() => view.unmount());
    }).not.toThrow();
  });
});

describe("WebGL context loss", () => {
  it("treats a null-style map as not-ready so layer effects skip it", () => {
    const dead = { style: null } as unknown as Parameters<
      typeof isMapStyleLive
    >[0];
    expect(isMapStyleLive(dead)).toBe(false);

    let seenReady: boolean | null = null;
    function Probe(): null {
      seenReady = useMap().ready;
      return null;
    }
    // Context says ready:true, but the map's style is gone (context lost).
    render(
      <MapContext.Provider value={{ map: dead, ready: true }}>
        <Probe />
      </MapContext.Provider>,
    );
    expect(seenReady).toBe(false);
  });

  it("does not call getLayer on a re-render after the WebGL context is lost", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <MapView>
          <RealisticLayer tick={0} />
        </MapView>,
      );
      await Promise.resolve();
    });

    const map = lastMap!;
    const getLayer = vi.spyOn(map, "getLayer");

    // GPU reclaimed while backgrounded → style nulled + event fired.
    act(() => map.loseContext());
    // App regains focus → a refetch re-runs the layer effect (tick change).
    expect(() => {
      act(() => {
        view.rerender(
          <MapView>
            <RealisticLayer tick={1} />
          </MapView>,
        );
      });
    }).not.toThrow();
    // The effect must have bailed (ready gated false) rather than touching the
    // dead style.
    expect(getLayer).not.toHaveBeenCalled();
  });

  it("recreates the map on refocus when the context was lost and never restored", async () => {
    await act(async () => {
      render(<MapView />);
      await Promise.resolve();
    });
    const first = lastMap!;

    // GPU reclaimed while backgrounded; `webglcontextrestored` never fires, so
    // the style stays null (blank canvas).
    act(() => first.loseContext());
    expect(isMapStyleLive(first as never)).toBe(false);

    // App regains focus → MapView detects the dead style and rebuilds the map.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(lastMap).not.toBe(first); // a fresh map instance was built
    expect(isMapStyleLive(lastMap as never)).toBe(true); // and it's live
  });

  it("does NOT recreate the map when the context restores normally", async () => {
    await act(async () => {
      render(<MapView />);
      await Promise.resolve();
    });
    const first = lastMap!;

    act(() => first.loseContext());
    act(() => first.restoreContext()); // browser restores the same context

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(lastMap).toBe(first); // same map — a repaint, not a rebuild
  });
});
