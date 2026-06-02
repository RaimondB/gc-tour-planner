// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.js";
import "./styles.css";

// The heavy read queries are bbox/param-keyed (caches, landuse, osm-parking,
// walking-graph), so panning the map mints a new cache entry per viewport.
// React Query's default gcTime is 5 min, which lets many multi-thousand-feature
// payloads pile up in the heap as the user pans — a prime suspect for the
// browser discarding the tab under memory pressure. Evict abandoned entries
// after 60s and treat results fresh for 30s (layers that want longer set their
// own staleTime, which wins per-query).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 60_000,
      staleTime: 30_000,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element missing from index.html");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
