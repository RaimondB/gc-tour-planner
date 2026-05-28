// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";
import { useMap } from "./MapContext.js";

/**
 * Small bottom-left overlay showing the current map zoom and center
 * coordinates. Used to tune per-layer minzoom thresholds — pan/zoom to
 * the exact view you care about, read the zoom off the badge, then say
 * "parking should appear at z14" instead of guessing.
 *
 * Returns `null` (renders nothing) when the map isn't ready yet — the
 * badge is rendered as a portaled DOM node so it sits over the canvas
 * without participating in any of the GL layer stacking.
 */
export function ZoomDebugBadge(): JSX.Element | null {
  const { map, ready } = useMap();
  const [info, setInfo] = useState<{
    zoom: number;
    lng: number;
    lat: number;
  } | null>(null);

  useEffect(() => {
    if (!ready) return;
    const update = () => {
      const c = map.getCenter();
      setInfo({
        zoom: Math.round(map.getZoom() * 10) / 10,
        lng: Math.round(c.lng * 1e5) / 1e5,
        lat: Math.round(c.lat * 1e5) / 1e5,
      });
    };
    update();
    map.on("zoom", update);
    map.on("moveend", update);
    return () => {
      map.off("zoom", update);
      map.off("moveend", update);
    };
  }, [map, ready]);

  if (!info) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: 8,
        bottom: 8,
        zIndex: 5,
        padding: "4px 8px",
        font: "12px ui-monospace, SFMono-Regular, Menlo, monospace",
        background: "rgba(0,0,0,0.65)",
        color: "#fff",
        borderRadius: 4,
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      <div>
        z<strong>{info.zoom.toFixed(1)}</strong>
      </div>
      <div style={{ opacity: 0.8 }}>
        {info.lat.toFixed(4)}, {info.lng.toFixed(4)}
      </div>
    </div>
  );
}
