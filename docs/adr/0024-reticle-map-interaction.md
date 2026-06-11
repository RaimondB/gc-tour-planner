# ADR-0024 — Reticle map interaction for the Find step

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** Raimond Brookman (owner)

## Context

In the Find ("caches") step the map was point-and-click ([FR-M6](../requirements/map-ui.md)):
one finger / mouse panned the map, a background **tap set the search center**, and cache
markers opened a popup on tap. The search circle's centre dot was a draggable handle.

This overloaded a single tap with two jobs — *set center* and *open cache* — and relied on
MapLibre's click-vs-drag discrimination, whose movement threshold is only a few pixels. The
result, reported in daily use: while repositioning the search area the user **kept opening a
cache popup by accident**, and stray taps could nudge the center. Repositioning a circle by
dragging a small centre handle is also fiddly on touch.

## Decision

Switch the Find step to a **centred-reticle model**, plus a pan-distance guard on marker
popups.

1. **Reticle, not tap-to-set.** The search circle is **pinned to the viewport centre**. The
   user **pans the map to aim** the search area; the circle is redrawn at the live map
   centre on every `move` frame (so it visually stays put while the basemap and caches slide
   underneath), and the new centre is **committed to `params.center` on `moveend`**. There is
   no background tap-to-set-center and no draggable centre handle.
2. **Center always follows the map** in the Find step (no lock toggle) — search center = map
   center. Simplest mental model; panning *is* the explicit intent that
   [ADR-0021/ux-strategy rule 1](../design/ux-strategy.md) reserves camera moves for.
3. **Pan-distance guard on cache/parking popups.** A marker popup opens only when the
   pointer moved **≤ ~6 px** between down and up (a near-stationary tap). A "click" that is
   really the tail of a pan is ignored. This is essential under the reticle model, where the
   user now pans *over* markers constantly. The threshold lives in one place
   (`apps/web/src/features/map/pointer-drag.ts`, unit-tested) and applies to the cache popup,
   the cluster-lab shift/⌘ selection, and the parking popup.
4. **One model on desktop and touch.** Panning is the same gesture with a mouse or one
   finger, so there is no desktop/touch divergence.
5. **Other steps unchanged.** In Pick-a-cluster / Plan-&-export the circle is frozen, dimmed,
   at the last committed centre; background clicks stay no-ops.

## Alternatives considered

- **Two-finger pan / one-finger move-circle** (MapLibre `cooperativeGestures`) — rejected:
  desktop has no "two fingers", so it splits the gesture model in two; `cooperativeGestures`
  is really for maps embedded in scrolling pages and flashes a "use two fingers" overlay; a
  stray one-finger drag would silently move the search area.
- **Long-press to set center** (tap = open cache, long-press = set center) — rejected for
  this pass: keeps tap-to-open but adds a less-discoverable gesture; the reticle removes the
  set-center tap entirely, which is cleaner. Kept on the table if reticle feedback is poor.
- **Center lock toggle** (reticle follows by default, a pin freezes it so you can pan to look
  around) — deferred: adds UI for a need not yet felt. The "always follows" model is simpler;
  revisit if users want to pan-to-browse without disturbing their area.
- **Just raise MapLibre's click threshold** (guard only, keep point-and-click) — rejected as
  the whole answer: fixes accidental popups but leaves the tap-does-two-things tension and
  the fiddly handle-drag. The guard ships *with* the reticle, not instead of it.

## Consequences

**Good**

- Repositioning the search area can no longer trigger a cache popup; the circle stays framed
  on screen; the interaction is identical on desktop and touch.
- Reuses the existing `circlePolygon` + `setData` redraw machinery — no DOM-overlay
  projection math, single circle representation, zoom scaling stays automatic.

**Costs / risks**

- You cannot pan purely to "look around" in the Find step without dragging the search center
  along (accepted; mitigated later by an optional lock toggle if wanted).
- `move` fires every animation frame during a pan; we redraw a 64-vertex polygon + a point
  per frame (cheap — the old handle-drag already `setData`'d on every mousemove). State
  (`params.center`) is only committed on `moveend`, so the debounced caches refetch is not
  churned mid-pan.
- Behaviour contract change: [FR-M6](../requirements/map-ui.md) and the step-① bullet in
  [ux-strategy.md](../design/ux-strategy.md) are updated in the same change.
