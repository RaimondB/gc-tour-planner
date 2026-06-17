// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { StrictMode, useEffect, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
  AuthProvider,
  AUTH_ME_QUERY_KEY,
  useAuth,
} from "./features/auth/AuthProvider.js";
import { setUnauthorizedHandler } from "./lib/api.js";
import { router } from "./router.js";
import { ConnectivityProvider } from "./features/shell/ConnectivityProvider.js";
import { TourSessionProvider } from "./features/tours/TourSessionProvider.js";
import { PwaUpdatePrompt } from "./features/shell/PwaUpdatePrompt.js";
import { PwaInstallPrompt } from "./features/shell/PwaInstallPrompt.js";
import { SessionExpiredGate } from "./features/shell/SessionExpiredGate.js";
import { initCloudflareAnalytics } from "./lib/cloudflare-analytics.js";
import "./styles.css";

// Cookieless usage analytics — no-ops unless VITE_CF_WEB_ANALYTICS_TOKEN is set
// (production only). See lib/cloudflare-analytics.ts / ADR-0030.
initCloudflareAnalytics();

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

/**
 * Bridges the auth context into the router's context and registers the global
 * 401 → /login interceptor. Holds back the router until the initial `/auth/me`
 * probe resolves, so the `/` route's guard never sees a transient "anonymous"
 * and flashes the login screen for an already-signed-in user.
 */
function AppRouter(): JSX.Element {
  const auth = useAuth();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // A 401 on an authenticated call means the session lapsed server-side.
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, null);
      void router.navigate({ to: "/login" });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  if (auth.status === "pending") {
    return (
      <div className="auth-loading" role="status">
        Loading…
      </div>
    );
  }

  return <RouterProvider router={router} context={{ auth }} />;
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element missing from index.html");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConnectivityProvider>
        <AuthProvider>
          <TourSessionProvider>
            <AppRouter />
          </TourSessionProvider>
        </AuthProvider>
        <PwaUpdatePrompt />
        <PwaInstallPrompt />
        <SessionExpiredGate />
      </ConnectivityProvider>
    </QueryClientProvider>
  </StrictMode>,
);
