// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listCaches } from "./lib/api.js";
import { DEFAULT_SEARCH, type SearchParams } from "./lib/search-params.js";
import { MapView } from "./features/map/MapView.js";
import { CachesLayer } from "./features/map/CachesLayer.js";
import { FilterSidebar } from "./features/search/FilterSidebar.js";
import { UploadDropzone } from "./features/upload/UploadDropzone.js";

export default function App(): JSX.Element {
  const [params, setParams] = useState<SearchParams>(DEFAULT_SEARCH);

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
      }),
    placeholderData: (prev) => prev,
  });

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
            onChange={setParams}
            cacheCount={cachesQuery.data?.caches.length}
            loading={cachesQuery.isFetching}
          />
        </div>
        <main className="app-main">
          <MapView initialCenter={params.center}>
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
