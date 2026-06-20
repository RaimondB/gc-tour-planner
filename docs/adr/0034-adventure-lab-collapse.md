# ADR-0034 — Collapse Adventure Labs to one node for clustering and the map

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Raimond Brookman (owner)

## Context

An Adventure Lab is one "place" a cacher visits, but it imports as 5–10 separate
stage rows ([FR-I15](../requirements/ingest.md)), each a normal cache with its
own coordinate, sharing an `adventure_id`. Two surfaces treated those stages as
independent caches, which the owner found wrong in practice:

1. **Pass-1 clustering** built the walking graph on every stage. A single
   adventure's tightly-packed stages form a high-connectivity blob that the
   clustering strategies (HDBSCAN\*/Louvain) happily return as its own dense
   micro-cluster — so the candidate list filled with "clusters" that were really
   just one adventure, crowding out real cache-rich loops.
2. **The map** drew a marker per stage. Below street zoom an adventure became an
   unreadable pile of overlapping purple dots, unlike geocaching.com which shows
   one pin per adventure until you're close.

There is **no adventure-level coordinate to anchor to**: Lab2Gpx exports only
per-`<wpt>` stage coordinates (confirmed — no adventure `<wpt>`, and the
`lab2gpx:adventureLab` extension carries only `stagesTotal`). Geocaching.com's
single pin is the adventure's own published location, stored server-side and not
in anything we ingest; the owner confirmed it is **not** stage 1. So an anchor
must be **derived** from the stages.

## Decision

Treat each adventure as **one node**, both for clustering and on the map.

1. **Anchor = centroid of the adventure's stages.** It's the truest "single coord
   for the whole" given no published coordinate is available, and is robust to
   missing/gap stage sequences (unlike "use stage 1").

2. **Pass-1 clustering collapses each adventure to one representative node**
   (`collapseAdventures`, run in `prepareClusteringContext` before the pool cap
   and walking graph). The representative is the **stage nearest the centroid**
   (the medoid) — a *real* cache row, so the walking graph and OSRM keep
   operating on actual routable locations rather than a synthetic point, while
   the node still sits "in the middle" of the adventure. The chosen cluster's
   ids are **expanded back to every stage** on output (`expandAdventureIds` in
   `computeClusters`), so Pass-2 still routes the whole adventure (with its own
   atomic/contiguity handling, [FR-I16](../requirements/ingest.md)). This is the
   "collapse & co-cluster" model: an adventure clusters *alongside* regular
   caches as a single member, so with the default `minClusterSize` a lone
   adventure can no longer be its own cluster, but two nearby adventures (or an
   adventure next to a cache pod) still cluster together.

3. **The map collapses below `AL_EXPLODE_ZOOM` (= `PARKING_MIN_ZOOM`, z12).**
   Below it, one purple pin per adventure at the centroid (with a stage-count
   badge); at/above it the pin gives way to the individual stage circles + `S{n}`
   labels (`CachesLayer`). A plain click on a collapsed pin zooms in to explode
   it; a modifier-click toggles the whole adventure in/out of the Cluster-Lab
   selection.

## Consequences

- **Optimistic Pass-1 score for spread-out adventures.** MST / tour-length
  estimates are computed on the single representative, so an adventure whose
  stages span (say) 2 km looks cheaper at discovery than it routes. We accept
  this: Pass-2's AL-aware atomicity + budget trim ([FR-I16]) handles the real
  routing cost, and most adventures are compact. The collapse is the explicit
  owner-chosen behaviour.
- **`minClusterSize` now counts adventures as 1.** A cluster needs that many
  *places* (caches or adventures), which is the intended reading.
- **Diagnostics (`poolSize`, connectivity, components) reflect the collapsed
  pool.** That's desirable — they describe what clustering actually operated on.
- **Map anchor (centroid) vs clustering node (medoid)** differ by metres;
  invisible to the user, and each is the right choice for its surface (a clean
  visual centre vs a real routable cache).
- Lab2Gpx remains the only AL source; if a future source exposes a real
  adventure coordinate, the derived centroid can be swapped for it without
  touching the collapse/expand machinery.

## Alternatives considered

- **Anchor on stage 1.** Rejected: the owner confirmed geocaching's pin isn't
  stage 1, and stage 1 may be absent/renumbered; the centroid is a more honest
  "middle".
- **Exclude ALs from clustering entirely, attach nearby adventures afterwards.**
  A reasonable model (and what `augmentClusterWithLabs`/[FR-I15] does manually),
  but the owner chose "collapse & co-cluster" so adventures participate in
  formation as first-class single nodes.
- **Client-side map clustering (MapLibre `cluster: true` / supercluster).**
  Rejected: that clusters *by proximity at render time*, mixing unrelated caches;
  we specifically want grouping by `adventure_id`, not by screen distance.
- **A synthetic centroid node in the walking graph.** Rejected: the graph and
  OSRM key off real cache rows; the medoid gives a near-centroid anchor without a
  fake coordinate.
