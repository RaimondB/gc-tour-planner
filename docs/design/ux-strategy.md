# UX strategy

This document captures the design principles the web app's layout follows. They are deliberate trade-offs — not house style — and should be read before any meaningful change to the sidebar, the map overlays, or the mobile experience.

## The single-screen principle

The application is a map-first tool. Every meaningful planning action — discover candidates, pick one, plan it, view the planned tour, download its GPX — must be achievable **without opening the drawer** on mobile. The drawer is reserved for *tuning settings*, not driving the main flow.

This means the map view itself surfaces the primary affordances via small floating buttons / pills:

- **Tour stats overlay** — top-centre pill showing km / total time when a tour is planned. Click → opens the Tour tab.
- **Discover FAB** — bottom-centre pill "Discover clusters" when caches are loaded but no candidates exist yet.
- **Cluster FAB row** — `◀ Plan #N/M (X caches) ▶` once candidates exist. Arrows step through candidates; centre button plans the focused one. Turns into a green `✓ Tour #N/M` when the focused cluster IS the planned one.
- **GPX download** — small button on the tour-stats overlay; one-tap GPX track export.

The hamburger menu is only needed for the rare flows:
- the very first GPX upload (one-time per data refresh),
- changing search filters (radius, type, etc.),
- tweaking plan or tour settings,
- the operator/debug tools (cog drawer).

## Tab split: by *which thing each setting affects*

The sidebar's three workflow tabs (Filter / Plan / Tour) each correspond to one stage of the pipeline. Settings live in the tab whose output they influence:

| Tab | Owns | Examples |
|-----|------|---------|
| **Filter** | What's on the map | Upload, search center + radius, cache types, "exclude my finds", availability, equipment, landuse context |
| **Plan** | What clusters get discovered | Distance budget, max caches, min cluster size, candidates-to-return, max link distance, clustering algorithm, landuse profile + weight |
| **Tour** | What the planned tour looks like | Fringe trim, visit time per cache, tool-cache bonus, walking speed, start preference + OSM parking filters, planned-loop summary, leg edits, GPX export |

A setting that *could* influence both stages goes in the upstream tab so the user sees consequences flowing downstream as they tweak. `distanceBudgetMeters` is a Plan setting because it constrains which clusters are even considered.

Re-planning a cluster after changing Tour-tab settings is cheap (one API call); re-discovering is expensive. This is the practical reason for the split: a sidebar layout that ties effort to where the user is looking.

## Tools drawer: operator-only

The cog icon in the top-right opens a right-slide-over drawer that holds everything operator/debug:

- Admin Precompute (warming `route_legs` / `cache_landuse`)
- Debug overlays (walking graph, OSRM route probe, purge bogus edges)
- Cluster Lab (manual selection + Explain)

These do not belong in the daily-flow tabs. Putting them behind a single cog keeps the workflow clean and the operator tooling discoverable.

## Mobile vs desktop

The same React tree, the same component layout. The CSS media query at `768px` swaps behaviour:

- **≥ 768 px (desktop)**: sidebar is always inline on the left (320 px); tools drawer slides over the right edge; FABs are hidden because the in-drawer affordances are already visible.
- **< 768 px (mobile)**: sidebar becomes a left-side drawer (≤ 85 vw) with hamburger toggle; map fills the screen; FABs are visible at the centre of the map for the main-flow actions; tap targets bump to ≥ 44 px; tagline in the header hides to save vertical space.

State persists across the breakpoint switch — turning your phone or resizing the window doesn't lose your tab, your filters, or your in-progress plan.

## Auto-switches and what the app decides for you

The app makes a few small UX decisions automatically:

- **Tab auto-switch on plan-success** — when a fresh plan lands, the active tab flips to Tour. The user explicitly clicked "plan this loop"; they want to see the result. Drawer state is left alone (auto-opening the drawer on mobile would intrude over the map showing the new polyline).
- **Map auto-fit on Tour-tab activation** — fits the polyline bounds. Covers the "I panned away, then re-opened Tour to find it" case.
- **Map auto-fit on cluster focus** — 250 ms debounced; covers hover-scrubbing across cluster rows without ping-pong.
- **`focusedClusterId` persists after plan-success** — so the FAB row keeps the prev/next navigation available and the middle button shows the "View tour #N/M" state.

The app does **not**:
- close the drawer when you switch tabs (you usually want to interact with the tab you just picked),
- auto-open the drawer when a plan lands (the polyline + numbered stops on the map + the stats overlay are enough),
- auto-clear `chosenClusterId` when you tweak a setting (Discover is the explicit "redo" trigger).

## Where to put new UI

When adding a control:

1. Decide which output it affects (caches shown / candidates / planned tour) → place in Filter / Plan / Tour tab.
2. If it's a primary action of the main flow, also surface it as a map FAB so mobile users don't need to open the drawer.
3. If it's operator/debug, put it behind the cog (Tools drawer).
4. Anything not in those three buckets should be questioned — maybe it doesn't belong in the UI yet.

A new setting that requires a drawer trip for every plan would be a regression of the single-screen principle. Push back before adding it.
