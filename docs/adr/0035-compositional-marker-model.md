# ADR-0035 — Compositional marker model & colour-blind-safe palette

- **Status:** Accepted
- **Date:** 2026-06-22
- **Deciders:** Raimond Brookman (owner)

## Context

Cache / Adventure-Lab (AL) stage rendering had drifted into inconsistency. Each
visual concern — kind, type, tour/cluster membership, status, collapse — was
hard-coded per mode across `CachesLayer`, `TourLayer`, and `ClustersPreviewLayer`,
so the same cache looked unrelated in each context and combinations fought:

- **Two numbering schemes in one tour.** Regular stops showed the visit-order
  number; routed AL stops showed `S{n}` big with the order crammed into a
  superscript — because `CachesLayer` stamped the AL stage label (popped to the
  very top via `moveLayer`) over the tour's order number.
- **Type colour lost in context.** A cache was forced red in a tour, orange in a
  cluster — a Mystery and a Traditional became indistinguishable once routed.
- **Colour was the only channel** distinguishing cache types — unfriendly to the
  ~8 % of men with red-green colour-blindness.
- **Palette defects on the green basemap:** Traditional and CITO shared the exact
  same hex; Letterbox collided with the AL purple; three greens (Traditional /
  CITO / Webcam) blended into forest landuse; EarthCache was near-black.
- **Mode bleed:** a cluster centroid floated over an active tour (it forced itself
  to the top of the style).
- **Badge collisions:** no reserved positions, so the parking `P` overlapped a
  stop and superscripts overflowed the marker.

## Decision

One **compositional** marker model. A marker is **base + centre + rings + corner
badges**, each channel independent so contexts layer predictably.

1. **Shape = kind (a non-colour channel).** Geocache = circle; AL stage = a purple
   **squircle** (a generated `addImage` icon). Only two shapes — the colour-blind
   second channel for "is this an Adventure Lab".
2. **Colour = type, preserved across every context.** A Mystery stays blue in a
   tour. Membership is shown by added rings / the tour line, never by recolouring
   the fill. The palette is revised (below).
3. **Inner glyph = type, redundant with colour.** A single basic-Latin letter per
   type (`T M ? L E ! V W G C O`), drawn as a separate centre-label layer (the
   map's demotiles glyph source is basic-Latin only — no Material-Symbols font, so
   per [FR-M4](../requirements/map-ui.md) type cues are letters/icons, never
   Groundspeak glyphs).
4. **Centre slot is context-driven but uniform.** Plain / cluster: the type letter
   (cache) or `S{n}`/`L{n}` stage-id (AL). In a tour: the **visit-order number for
   ALL stops**; the identity demotes to the BR corner badge. This fixes the dual
   numbering.
5. **Reserved corner slots** (`cornerIconOffset`/`cornerTextOffset`): **TR** =
   tool-required wrench, **TL** = solved `✓`, **BL** = disabled `Z`, **BR** =
   demoted identity. **Status adornments are ICONS, identity is LETTERS** — so a
   status badge can never be read as a type letter (the tool cue is a wrench, not
   a "T" that would collide with Traditional).
6. **Tour ownership de-dup.** When a tour is active, the caches it owns (routed
   stops + dropped candidates) are hidden in `CachesLayer` (their *hit* target
   stays, so the popup still opens); `TourLayer` is the single authority for how a
   routed/dropped cache renders. No double-draw, no `S{n}`-over-order bleed.
7. **Dropped candidates** keep type colour + identity but recede (reduced opacity)
   and are marked excluded by a **dashed** red ring (dashed-vs-solid is the
   colour-blind-safe channel; MapLibre circle strokes can't dash, so it's an icon
   overlay) with **no** visit-order number.
8. **Context hierarchy** `tour > cluster > plain`: when a tour is active the
   cluster preview de-emphasises (lower opacity) and stops forcing its centroids
   above the tour.
9. **Unified collapse.** One `collapseByProximity` (wrapping `clusterByPixelProximity`)
   serves both the tour-stop and AL-pin collapse, with one label rule (contiguous
   run → `3–7`, else `×N`). Pixel-proximity + click-to-zoom is retained
   ([ADR-0034](0034-adventure-lab-collapse.md)).

### Revised palette (`TYPE_COLORS` in `marker-style.ts`)

Because shape + letter now carry identity, colour's job is fast *grouping*, not
sole identification. Changes: Multi amber→orange `#ef6c00`; Letterbox purple→magenta
`#c2185b`; EarthCache near-black→`#795548`; Event→`#d32f2f`; Webcam olive→slate
`#455a64`; CITO green→olive `#9e9d24` (breaks the Traditional duplicate). Traditional
green, Mystery blue, Virtual teal, Wherigo navy, AL purple, Other gray are kept. A
unit test locks "no duplicate hex".

### Why canvas `addImage` over SDF / a sprite sheet

SDF icons are monochrome — they can't carry shape + fill + white stroke in one
image. A build-time sprite sheet is heavier than runtime canvas when the colours
are already known in TS. We generalise the existing `ensureSolvedBadgeIcon` canvas
pattern: a small, bounded image set (one purple AL squircle + the badge icons),
each cached by `map.hasImage`, with a circle-layer fallback when no 2D canvas is
available (jsdom in tests).

## Consequences

- **Routed stops are now type-coloured, not red.** The most visible behavioural
  change; red survives only as the tour line/arrows accent. Intended per (2).
- **Every cache shows a centre letter at z ≥ 12.** Slightly denser at street zoom,
  but it's the colour-blind redundancy.
- **New shared modules** `marker-style.ts` (palette, glyphs, slots, ring styles,
  image factories) and `marker-collapse.ts` centralise what three files duplicated.
- **A declarative layer registry (one ordered z-order list replacing the scattered
  `addLayer`/`moveLayer` juggling) is the natural next step** but was deferred — it
  benefits from live z-order verification and is not user-visible.
- Two shapes only: more cache *types* than shapes, by design — type rides colour +
  letter, not shape, so the shape set stays at two.

## Alternatives considered

- **A distinct shape per cache type.** Rejected: ~12 types, too many shapes to
  read; colour + letter handle type, shape handles only the binary kind.
- **Composite per-feature images (whole marker baked into one PNG).** Fewer layers
  but a combinatorial image set (kind × type × every status) and badge tweaks mean
  regenerating images. Rejected in favour of separate-layer-per-role (the owner's
  choice), which keeps the image set tiny and badges editable via expressions.
- **Recolour fill by context (keep today's red/orange).** Rejected: it throws away
  type identity, the core complaint.
