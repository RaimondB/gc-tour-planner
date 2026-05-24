// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { useQuery } from "@tanstack/react-query";
import { listCaches } from "./lib/api.js";
import { DEFAULT_SEARCH, type SearchParams } from "./lib/search-params.js";
import { MapView } from "./features/map/MapView.js";
import { CachesLayer } from "./features/map/CachesLayer.js";
import { LanduseLayer } from "./features/map/LanduseLayer.js";
import { RadiusLayer } from "./features/map/RadiusLayer.js";
import { FilterSidebar } from "./features/search/FilterSidebar.js";
import { UploadDropzone } from "./features/upload/UploadDropzone.js";

export default function App(): JSX.Element {
  const [params, setParams] = useState<SearchParams>(DEFAULT_SEARCH);
  const mapRef = useRef<maplibregl.Map | null>(null);

  // Mirror query at App level so the sidebar can show the count without
  // CachesLayer having to lift it up. Same queryKey → same cache entry, no
  // double fetch.
  const cachesQuery = useQuery({
    queryKey: ["caches", params],
    queryFn: () =>
      listCaches({
        center: params.center,
        radiusM: params.radiusM,
        types: params.types.length > 0 ? params.types : undefined,
        excludeFound: params.excludeFound || undefined,
        contexts: params.contexts.length > 0 ? params.contexts : undefined,
      }),
    placeholderData: (prev) => prev,
  });

  const handleParamsChange = useCallback(
    (next: SearchParams, opts?: { fly?: boolean }) => {
      setParams(next);
      if (opts?.fly && mapRef.current) {
        mapRef.current.flyTo({
          center: next.center,
          zoom: zoomForRadius(next.radiusM),
          essential: true,
        });
      }
    },
    [],
  );

  const handlePickCenter = useCallback((lngLat: [number, number]) => {
    setParams((prev) => ({ ...prev, center: lngLat }));
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>gc-tour-planner</h1>
        <p>Plan closed-loop geocaching tours from filtered cache clusters.</p>
      </header>

      <div className="app-body">
        <div className="left-pane">
          <UploadDropzone />
          <FilterSidebar
            value={params}
            onChange={handleParamsChange}
            cacheCount={cachesQuery.data?.caches.length}
            loading={cachesQuery.isFetching}
          />
        </div>
        <main className="app-main">
          <MapView
            initialCenter={params.center}
            initialZoom={zoomForRadius(params.radiusM)}
            onPickCenter={handlePickCenter}
            onReady={(m) => {
              mapRef.current = m;
            }}
          >
            <LanduseLayer params={params} />
            <RadiusLayer params={params} />
            <CachesLayer params={params} />
          </MapView>
        </main>
      </div>

      <footer className="app-footer">
        Map data &copy;{" "}
        <a href="https://www.openstreetmap.org/copyright">
          OpenStreetMap contributors
        </a>
      </footer>
    </div>
  );
}

/**
 * Pick a zoom level so the search-radius circle roughly fits the viewport.
 * Empirical mapping — refine if user reports it's too tight/loose.
 */
function zoomForRadius(radiusM: number): number {
  if (radiusM <= 1_000) return 14;
  if (radiusM <= 2_500) return 13;
  if (radiusM <= 5_000) return 12;
  if (radiusM <= 10_000) return 11;
  if (radiusM <= 20_000) return 10;
  return 9;
}
