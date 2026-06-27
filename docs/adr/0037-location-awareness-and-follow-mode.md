# ADR-0037 — Location awareness & follow-mode navigation

- **Status:** Accepted
- **Date:** 2026-06-27
- **Deciders:** Raimond Brookman (owner)

## Context

gctp had no concept of *where the user is*. The owner wanted to: see their live
GPS position on the map, see how far away each saved tour is, find/sort tours by
proximity, and "navigate" a tour with a live distance-to-next-stop — while leaving
the actual walking directions to the phone's maps app.

## Decision

1. **Opt-in, on-device only (privacy).** A live `navigator.geolocation.watchPosition`
   runs **only** when the user enables it. The position lives in an in-memory
   provider; only the *enabled* preference is persisted (localStorage). The
   position is **never sent to the server or persisted** — every distance / sort /
   follow calculation is client-side. No new endpoint receives coordinates. The
   watch is torn down while the tab is hidden (battery) and resumed on return;
   permission denial degrades to a clear "denied" state, never a crash.
2. **One app-wide `LocationProvider`, above the router.** Both the planner
   (`App.tsx`) and the My Tours route read the same `useLocation()` — so it sits
   above `RouterProvider` alongside the other cross-route providers
   ([ADR-0029](0029-frontend-offline-resilience-caching-and-state.md)).
3. **Position rendered as map layers**, not a `maplibregl.Marker`: a "you are
   here" dot + a translucent accuracy ring, following the existing `useMap()` +
   upsert-source + `map-layers.ts` z-order idiom ([ADR-0035](0035-compositional-marker-model.md)).
   Shown on the planner map **and** the public shared-tour view.
4. **Distance + nearest sort are client-side.** The lean `GET /tours` summary now
   carries `startPoint` (the `start_point` column via `ST_AsGeoJSON`); the My Tours
   list computes "X km away" and the "Nearest" sort from the user's position with a
   shared `haversineMeters` helper. No `?near=` server query — instant, offline-
   friendly, and the position stays on the device.
5. **Follow mode hands off to the device maps app.** When a tour is open and
   location is on, gctp shows the distance to the **next stop** in plan order,
   auto-advances when the user is within ~30 m, and a per-stop "Navigate" opens
   Google/Apple Maps for the real walking directions (reuses the existing
   `parkingNavTarget` platform handoff). The advance logic is a pure, unit-tested
   `advanceFollow(stops, position, visited)`.

## Alternatives considered

- **In-app turn-by-turn / live re-routing.** Rejected — it reinvents what
  Google/Apple Maps do well (turn prompts, off-route detection, voice) and needs a
  routing/nav engine. gctp owns *which stop is next*; the maps app owns *how to walk
  there*.
- **Server-side proximity query (`GET /tours?near=lng,lat`).** Rejected — it would
  send the user's position to the server, break the offline list, and add a request
  per position update. Surfacing `startPoint` on the summary and sorting on the
  client is simpler and more private.
- **`maplibregl.GeolocateControl`.** Rejected — less control over styling, the
  opt-in/privacy flow, and integration with the follow-target highlight; the
  GeoJSON-layer idiom is already established.

## Consequences

**Good**
- Live position, "how far is this tour", nearest-first, and guided walking — with
  no coordinate ever leaving the device and no new server surface.
- Follow mode is small and robust (pure `advanceFollow`; directions delegated).

**Trade-offs**
- High-accuracy `watchPosition` uses battery while active — mitigated by opt-in +
  tab-hidden teardown.
- Distance/sort need a fix; the UI degrades to the plain newest-first list when
  location is off/denied/unavailable.

**Not in scope**
- Turn-by-turn, compass-heading arrow, background/geofenced tracking.
