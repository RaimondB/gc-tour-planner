// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { appIdentity, resolveAppEnv } from "./src/lib/app-identity.js";

// Per-environment identity (UAT carries a "(UAT)" name + badged icons). Resolved
// at build time from VITE_APP_ENV (default "uat"). BUMP `v` ON EVERY ICON BYTE
// CHANGE — the WebAPK minter keys the installed icon on the URL.
const id = appIdentity(resolveAppEnv(process.env.VITE_APP_ENV));
const v = "v=4";

// Stamped into the bundle so the About dialog can prove which build is running —
// the only reliable way to confirm an installed (prompt-strategy) PWA actually
// took a new deploy vs. is still serving the precached old SW. Changes on every
// build regardless of git/commit state (git isn't in the Docker build context).
const buildTime = new Date().toISOString();

export default defineConfig({
  define: {
    __APP_BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [
    react(),
    // Fill the env-specific bits of index.html (title, iOS label + touch icon).
    // `order: "pre"` so these placeholders are resolved before Vite's own HTML
    // env replacement ever sees them.
    {
      name: "gctp-html-app-identity",
      transformIndexHtml: {
        order: "pre" as const,
        handler: (html: string) =>
          html
            .replaceAll("%APP_TITLE%", id.title)
            .replaceAll("%APPLE_APP_TITLE%", id.shortName)
            .replaceAll(
              "%APPLE_TOUCH_ICON%",
              `/apple-touch-icon${id.iconSuffix}.png?${v}`,
            ),
      },
    },
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: id.name,
        short_name: id.shortName,
        description:
          "Plan parking-aware geocaching walking tours and export them to your GPS.",
        theme_color: "#bf360c",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          // `id.iconSuffix` selects the prod ("") or UAT ("-uat", badged) set.
          // BUMP `v` (above) ON EVERY ICON BYTE CHANGE. The filenames are stable,
          // and the browser's WebAPK minter keys the installed home-screen icon
          // on the URL — so if the bytes change but the URL doesn't, a reinstall
          // is handed the previously-minted (stale) icon. The `no-cache` header
          // on /icons/* only fixes the in-browser HTTP cache, not the WebAPK.
          // pwa-192/512 are the ROUNDED "display" icons (shown in full on the
          // splash); pwa-maskable-512 is FULL-BLEED for the cropped home icon.
          {
            src: `/icons/pwa-192${id.iconSuffix}.png?${v}`,
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: `/icons/pwa-512${id.iconSuffix}.png?${v}`,
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: `/icons/pwa-maskable-512${id.iconSuffix}.png?${v}`,
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webp,woff2}"],
        // Take control of the open page as soon as a new SW activates. Without
        // this, clicking "Reload" on the update toast posts SKIP_WAITING and the
        // new worker activates, but never controls the current tab — so the
        // `controlling`/controllerchange event vite-plugin-pwa waits on to reload
        // never fires, and the button appears to do nothing (most visibly in a
        // desktop browser tab). We stay on the `prompt` strategy, so the new SW
        // still only activates on the user's click — no mid-session chunk swap.
        clientsClaim: true,
        navigateFallback: "/index.html",
        // Never serve the SPA shell for navigations the origin/edge must handle:
        //  - /api/*       → the backend (e.g. the OAuth start /api/auth/google).
        //  - /cdn-cgi/*   → Cloudflare's reserved paths, incl. the Access login
        //    callback /cdn-cgi/access/authorized. Without this the SW hijacks
        //    that callback, renders the SPA "Not Found" on /cdn-cgi/…, and the
        //    Access cookie is never set — so Google sign-in dead-ends in any
        //    browser whose SW is active and that needs a fresh Access session
        //    (e.g. Chrome with 3rd-party cookies restricted).
        //  - /_gpx/*      → the SW-mediated GPX download (see below). It's a
        //    navigation, so without this denylist entry the navigateFallback
        //    would answer it with the SPA shell instead of the file.
        navigateFallbackDenylist: [/^\/api\//, /^\/cdn-cgi\//, /^\/_gpx\//],
        runtimeCaching: [
          {
            // SW-mediated download. In-page anchor/blob `download` is silently
            // swallowed inside Android "installed" PWAs (notably Edge, whose
            // install is a shortcut, not a true WebAPK) — nothing surfaces. The
            // fix: the client pre-stages the GPX as a Response carrying
            // `Content-Disposition: attachment` in the `gpx-downloads` cache
            // (lib/sw-download.ts), then navigates to `/_gpx/<id>/<name>`. This
            // CacheFirst route serves that Response verbatim, so the browser
            // routes it through the OS download manager — a real, surfaced
            // download (notification + tap-to-open, filename preserved) that
            // also works offline. Single-use: the client evicts after firing,
            // and the short expiry self-cleans anything it misses. [ADR-0032]
            urlPattern: ({ url }) => url.pathname.startsWith("/_gpx/"),
            handler: "CacheFirst",
            options: {
              cacheName: "gpx-downloads",
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 30 },
            },
          },
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
