// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";

// A fake MapLibre map that mirrors the one trait that matters for this
// regression: after `remove()`, `getLayer` dereferences a nulled `style` and
// throws — exactly like the real `Map.getLayer(id) { return this.style.getLayer(id) }`.
class FakeMap {
  style: { getLayer: (id: string) => undefined } | null = {
    getLayer: () => undefined,
  };
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  private canvas = Object.assign(document.createElement("canvas"), {});
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
  private fire(event: string): void {
    for (const cb of this.handlers.get(event) ?? []) cb({});
  }
  getLayer(id: string): undefined {
    // Throws "Cannot read properties of null (reading 'getLayer')" once removed.
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
    this.style = null; // <- the trap: subsequent getLayer() now throws
  }
}

vi.mock("maplibre-gl", () => ({
  default: { Map: FakeMap },
}));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

// Stub the browser APIs MapView constructs that jsdom lacks.
beforeEach(() => {
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
const { useMap } = await import("./MapContext.js");

/** A layer whose cleanup drops its layer the way the real layers do. */
function LayerWithGetLayerCleanup(): null {
  const { map } = useMap();
  useEffect(() => {
    return () => {
      // The exact shape every real layer uses on teardown.
      if (map.getLayer("some-layer")) map.removeLayer?.("some-layer");
    };
  }, [map]);
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
      // let the fake fire `load`
      await Promise.resolve();
    });

    // React unmounts parent-first: MapView's cleanup runs before the layer's.
    // Without the deferred teardown, the layer cleanup's `map.getLayer` would
    // throw on the removed map and surface as an unmount error.
    expect(() => {
      act(() => {
        view.unmount();
      });
    }).not.toThrow();
  });
});
