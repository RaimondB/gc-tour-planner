// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "gc-tour-planner",
        short_name: "GC Tour",
        description:
          "Plan parking-aware geocaching walking tours and export them to your GPS.",
        theme_color: "#bf360c",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icons/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/pwa-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/pwa-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webp,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Saved tours + their snapshots → render offline once viewed online.
            // The regex is INLINE on purpose: workbox stringifies this function
            // into the generated SW but does NOT carry over closed-over module
            // vars, so a named const here becomes a runtime ReferenceError. It's
            // UUID-anchored so it can NOT match the planning endpoints sharing
            // the /tours prefix (/tours/clusters, /tours/plan, … — those POSTs
            // must never be served from cache). Tested against pathname (not the
            // full href) because a `^/`-anchored regex can't match a same-origin
            // href that begins with the scheme/host.
            urlPattern: ({ url }) =>
              /^\/api\/tours(\/[0-9a-fA-F-]{36}(\/preview)?)?$/.test(
                url.pathname,
              ),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "saved-tours",
              cacheableResponse: { statuses: [0, 200] },
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
            },
          },
          {
            // The session probe: network-first so a live session always wins,
            // but fall back to the last-known answer when offline. Without this
            // an offline launch fails `/auth/me`, the app treats the user as
            // logged out, and bounces to Google login (which can't run offline)
            // — trapping them before their cached tours (FR-W3).
            urlPattern: ({ url }) => url.pathname === "/api/auth/me",
            handler: "NetworkFirst",
            options: {
              cacheName: "auth-me",
              networkTimeoutSeconds: 3,
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 1, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            // Every other API call needs the network — planning needs the live
            // API + OSRM, and there's no useful stale answer to serve.
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkOnly",
          },
          // NB: map tiles are deliberately NOT cached by the SW. OSM's tile
          // usage policy forbids downloading tiles for offline use, and a
          // self-hosted style would be a per-deployment choice. Offline, the
          // app falls back to the tour's stored snapshot (FR-W4) instead.
        ],
      },
      // Keep the SW out of `pnpm dev` so a stale precache never masks hot reload.
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL ?? "http://localhost:3030",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    sourcemap: true,
    outDir: "dist",
  },
});
