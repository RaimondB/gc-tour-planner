# Frontend (React + Vite)

- **State.** TanStack Query for all server state. Local component state with `useState` / `useReducer`; **no** global store (Zustand/Redux) unless a concrete pain point appears.
- **Map.** A single `MapView` component wraps MapLibre. Layers (cache markers, landuse polygons, tour polyline, parking marker) are independent feature components that read query state and push sources/layers to the map ref.
- **Filter sidebar.** Owns the filter form state; pushes to the URL search params (so refresh and sharing preserve view). Debounced; calls `GET /caches` and `POST /tours/plan` via the generated client.
- **API client.** Generated from NestJS OpenAPI via `openapi-typescript-codegen` at build time. Never hand-write fetch calls.
- **Auth (M6).** Session cookie (httpOnly, `SameSite=Lax`) set by the API on login; an `AuthProvider`/`useAuth` reads `GET /auth/me` to know the current user. `api.ts` sends `credentials: "include"` and echoes the `csrf` cookie as `X-CSRF-Token` on mutations; a central 401 handler redirects to `/login`. No tokens in localStorage.
- **Routing (M6).** TanStack Router (first router in the app) splits public routes (`/login`, `/register`, `/shared/:slug`) from the protected app (today's `App.tsx` becomes the `/` route). See [design/auth-and-sharing.md](../design/auth-and-sharing.md).
- **PWA (FR-W1–W4, [ADR-0028](../adr/0028-pwa-installability-offline-and-native-share.md)).** `vite-plugin-pwa` + workbox produce a manifest + service worker at build time; the SW precaches the app shell and registers with a `prompt`-strategy update toast. Runtime caching is `NetworkOnly` for `/api/*` except the saved-tour reads, which use `StaleWhileRevalidate` so a previously-opened tour renders offline. nginx serves `sw.js` / `manifest.webmanifest` with `Cache-Control: no-cache` (the hashed asset rule would otherwise pin a stale SW). A per-tour WebP **map snapshot** is captured client-side and stored as a `bytea` column (`PUT/GET /tours/:id/preview`), used as the offline basemap and list thumbnail. Self-hosted icons, no CDN.

## Offline resilience & lifecycle ([ADR-0029](../adr/0029-frontend-offline-resilience-caching-and-state.md))

Hard rules learned shipping the PWA; the full rationale + incident list is in
[ADR-0029](../adr/0029-frontend-offline-resilience-caching-and-state.md), and a
fast agent checklist in the [`frontend-pwa-offline`](../../.claude/skills/frontend-pwa-offline/SKILL.md) skill.

- **Connectivity is a first-class app state.** One authoritative probe
  (`GET /api/health`) lifted into a `ConnectivityProvider`/`useOnline` context;
  an offline indicator + banner; online-only actions disabled with a reason;
  view/open/export of an already-loaded tour stay available.
- **The opened tour has one owner above the router.** `TourSessionProvider`
  (mounted around the router) owns "which saved tour is open" + its data —
  persisted id in `localStorage`, full detail mirrored to **IndexedDB**
  (`lib/tour-cache.ts`), React Query for the fetch. Transitions are explicit
  (`openTour`/`closeTour`), persisted on **intent**. This replaced scattered
  `useState` + racing mount effects + router-history transport that lost tour
  context offline. (Scoped providers like this are not the banned global store.)
- **Auth status never derives from connectivity.** An errored `/auth/me` keeps
  the last-known user (cold-start offline restore); only a clean `401 → null`
  signs out. A probe flipping `online` must not flip identity.
- **SW navigation fallback excludes every origin/edge path:**
  `navigateFallbackDenylist: [/^\/api\//, /^\/cdn-cgi\//]` (the latter is the
  Cloudflare Access callback). Stable-named assets are `no-cache` (never
  `immutable`); PWA icon changes bump a `?v=N` on the manifest `src`s because the
  installed WebAPK is keyed on the URL.
- **MapLibre ops are `ready`-gated and lifecycle-safe**, and the router has a
  recoverable `defaultErrorComponent` (Reload / Try again + stack) so a transient
  render error is never a dead end.
