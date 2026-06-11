# UX strategy

This document captures the design principles the web app's layout follows. They are deliberate trade-offs — not house style — and should be read before any meaningful change to the command panel, the journey rail, the map overlays, or the mobile experience.

> **2026-06 overhaul.** The app moved from a three-tab left sidebar (Filter / Plan / Tour) with map FABs to a **map-first command panel + journey rail**. The historical tab/FAB model is described at the end under _History_; the sections below describe the current design.

## The single-screen principle

The application is a map-first tool. The map is full-bleed; everything else floats over it or docks beside it. Every meaningful planning action — find caches, discover candidates, pick one, plan it, view the planned tour, download its GPX — is reachable on every viewport without hunting through menus.

Two persistent surfaces drive the flow:

- **Journey rail** — a stepper floating top-centre over the map: `① Find caches · ② Pick a cluster · ③ Plan & export`. It is the always-visible "where am I": each step shows done (✓) / current (filled, `aria-current="step"`) / locked (🔒 + a reason tooltip). Tapping an enabled step switches the command panel to it; ←/→ move between steps for keyboard users.
- **Command panel** — a single adaptive container holding the active step's controls. Right-hand **dock** on desktop (≥768 px); draggable **bottom sheet** with three snap points (peek / half / full) on mobile. Its top **peek area** holds the step's primary call-to-action, so the main flow is reachable even when the sheet is collapsed.

There is no separate hamburger drawer and no map FABs — the panel is the one place for step controls on both viewports, and the rail is the one place for navigation.

## Steps: by _which thing each stage produces_

The flow is three mandatory steps. Each owns the settings whose output it influences, so consequences flow downstream as the user tweaks:

| Step                 | Owns                             | Examples                                                                                                                          |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **① Find caches**    | What's on the map                | Upload, search center + radius, cache types, "exclude my finds", availability, equipment, landuse context                        |
| **② Pick a cluster** | What clusters get discovered     | Distance budget, min cluster size, candidates-to-return, max link distance, clustering algorithm, landuse profile + weight |
| **③ Plan & export**  | What the planned tour looks like | Fringe trim, visit time per cache, tool-cache bonus, walking speed, start preference + OSM parking filters, planned-loop summary, leg edits, GPX export |

A setting that _could_ influence both stages goes in the upstream step. `distanceBudgetMeters` is a step-② setting because it constrains which clusters are even considered. Re-planning a cluster after changing step-③ settings is cheap (one API call); re-discovering is expensive — that asymmetry is why the split exists.

Step gating mirrors the old tab-enablement: **Pick a cluster** unlocks once caches are loaded; **Plan & export** unlocks once a cluster is picked (or a plan exists). Locked steps show the reason on hover/long-press.

## Advanced options: one consistent disclosure

Every "advanced" control lives in a single uniform component — `AdvancedSection` (`features/shell/AdvancedSection.tsx`) — styled identically wherever it appears (filters, cluster settings, tour settings, developer downloads, per-cluster metrics, upload options). This replaced the previous scatter of ad-hoc `<details>` blocks. Advanced controls stay **inline, attached to the step they belong to** — never hoisted into a separate global settings screen — so they sit next to what they affect.

## Admin tools: admin-only

The cog icon in the header — **rendered only when `user.isAdmin`** — opens a right-slide-over drawer (`AdminToolsPanel`) holding everything operator/debug:

- Admin Precompute (warming `route_legs` / `cache_landuse`)
- Debug overlays (walking graph, OSRM route probe, purge bogus edges)
- Cluster Lab (manual selection + Explain)

Non-admins see no cog and none of these affordances (they all call `/admin/*` or are debug-only). This keeps the daily flow clean and the operator tooling out of reach of normal users.

## Map interaction model (journey-aligned)

The camera and the search circle behave predictably, and what a background map gesture does depends on the active step. Two rules above all:

1. **The app moves the camera only on explicit user intent** — picking/framing a cluster (tap), planning a tour, or pressing the on-map **⊕ Frame** control. Never on hover, never as a side effect of focus, never while/after the user pans. Pan/zoom is always preserved. (In step ① the user's *own* pan is intent: it repositions the search area — see below.)
2. **The search-radius circle is a step-① tool, not an always-live click target.**

Per step:

- **Start-point pick (any step)** — when `startPreference === "Pick a point on the map"` (`user-supplied-point`), a background map **tap** sets the **tour start point** (amber "P" preview). The Plan button is disabled until a point is set. This is the one background-tap action that survives the reticle model; in the Find step it coexists with pan-to-aim — panning still repositions the search area, a stationary tap drops the start point.
- **① Find caches — reticle model** ([ADR-0024](../adr/0024-reticle-map-interaction.md)). The radius circle is **pinned to the viewport centre**; the user **pans the map to aim** the search area, and the new centre is committed when the camera settles (`moveend`). There is **no tap-to-set-center** and **no draggable handle** — both invited accidental moves and accidental cache popups while repositioning. A cache popup opens only on a near-stationary **tap**; a "click" that is really the tail of a pan (pointer moved beyond ~6 px between down and up) is ignored, so panning over markers never pops a cache. The camera does not jump on a centre commit (the pan already placed the view). Desktop and touch share this one model.
- **② Pick a cluster** — a background click is a no-op (it never moves the search center). **Tapping a cluster centroid or its list row frames + picks it** (the one explicit camera move; replaces the old hover-fit and dbl-click-to-select). Desktop hover only brightens the cluster (`focusedClusterId`) — no camera. The radius circle is dimmed, non-interactive context.
- **③ Plan & export** — a background click is a no-op (edit-mode leg clicks keep their own handlers). The camera frames the tour once when planning completes and via the ⊕ Frame control.

**Stale-search guard:** if the search inputs (center / radius / filters) change after clusters were discovered, the discovered clusters no longer match the visible area. The Pick-a-cluster peek shows _"Search area changed — Re-discover"_ and the mismatched clusters are dimmed, so clusters never silently sit outside a moved circle.

The **⊕ Frame** control (bottom-right on desktop, top-right under the rail on mobile) re-centres the current context on demand: caches-in-radius (step ①) / focused cluster (step ②) / planned tour (step ③).

## Mobile vs desktop

The same React tree; CSS at the `768px` breakpoint swaps the command panel's shape, and `CommandPanel` switches its interaction model:

- **≥ 768 px (desktop)**: command panel is an inline right dock (360 px); the admin tools drawer slides over the right edge.
- **< 768 px (mobile)**: the command panel is a fixed bottom sheet with **four** snap points (**closed** / **peek** / half / full). The entire grab bar — not a tiny handle — is the drag/tap target, so it reacts reliably; dragging follows the finger 1:1 and a tap toggles closed↔peek. **closed** slides the sheet off-screen leaving only a slim labelled grab bar, so the map is fully usable; tap it (or drag up) to bring the panel back. **peek** (the default) is sized to fit the grab bar + the step's **primary CTA only** — the main-flow button (Find clusters / Discover / Plan, and the Tour step's GPX track/route downloads) is visible without the settings body, over a near-full map. The journey rail also collapses: only the current step shows its label (pill); the others become circular markers. Tap targets are ≥ 44 px; the header tagline / cog label / name chip hide to save width.

  **Cluster cards.** The candidate clusters are compact cards living in the **"Pick a cluster" peek** so the default drawer view is the cards + an active **Plan cluster #N** button (discovery pre-picks the top candidate). Each card is a single-line stat button (`#N · M caches · ~km · ~time`) with the dev metrics tucked behind an **ⓘ info icon** — no second line by default. On **mobile** they're a horizontal scroll-snap **carousel** (native swipe = reliable input; the card that settles in the centre is framed + picked; collapsing the sheet then leaves just the map and that one cluster). On **desktop** they're a **vertical list** in the dock (capped height, scrollable; picking is a click). The discovery *settings* stay in the drawer body below.

  **Map-fit inset.** The sheet reports its on-screen height to the map-fit logic, which adds it as bottom padding — so framing a cluster or tour lands the content in the visible area *above* the sheet, never hidden behind it.

State persists across the breakpoint switch and across reloads — the active step (`ui:active-step`), the sheet snap (`ui:sheet-snap`), filters, plan settings, viewport, and in-progress leg edits all survive.

## Journey consistency (forward + backward)

Navigating to a phase — by the rail, a peek CTA, or the auto-jump to Tour on plan-success — restores that phase's context, the same way every time:

| Enter phase | Camera re-frames to | Drawer |
|-------------|---------------------|--------|
| Find caches | the **whole search circle** (center ± radius) | reset to the default (peek) snap |
| Pick a cluster | the chosen/focused cluster (else all candidates, else the circle) | reset to default |
| Plan & export | the routed tour polyline | reset to default |

- Re-framing fires **only on an explicit phase change** (via an `[activeStep]`-only effect that reads the latest data through a ref) — so Discover never moves the camera, and the **first mount is skipped** so a reload honors the persisted viewport. A replan while already on Tour still refits.
- **Step auto-switch on plan-success** — a fresh plan flips the active step to _Plan & export_.
- **Tap-to-frame** — picking a cluster (map or carousel) frames it once; this is the only focus→camera path.

**Staleness / Re-discover.** `discoverInputKey(params, planSettings)` hashes *every* input to `discoverClusters` — the search pool **and** the discovery settings (min cluster size, link distance, distance budget, clustering algorithm, top-N, landuse weight/profile, start preference, OSM-parking filters). It's captured on each discover; when the live key drifts, the clusters are flagged stale: the **"Pick a cluster" rail chip shows an attention dot**, the peek shows a **Re-discover** banner, and the Find-step button relabels to **"Re-discover →"**. The "Find clusters →" button **navigates without recomputing** when clusters are present and fresh; it only re-runs discovery when there are none or they're stale. A planned tour is **left untouched** when the cluster set goes stale.

The app does **not**:

- move the camera on hover or while you pan,
- move the search center outside the Find phase,
- auto-clear `chosenClusterId` or the planned tour when discovery inputs drift (Re-discover is the explicit "redo"; the stale dot/banner nudge you).

## Accessibility & touch

- Journey rail is an ordered stepper (`<ol>` + buttons) with `aria-current="step"`, disabled+`title` for locked steps, and ←/→ keyboard navigation.
- The bottom sheet is `role="dialog"`; the drag handle doubles as a tap-to-cycle-snap button.
- All interactive targets meet the ≥44 px floor (`--tap-min`); cluster rows are real buttons so they work on touch without hover.
- Animations respect `prefers-reduced-motion`.

## Where to put new UI

1. Decide which output it affects (caches shown / candidates / planned tour) → place in the matching step body.
2. If it's a primary action of that step, surface it in the step's **peek** so it stays reachable in the collapsed mobile sheet.
3. If it's an advanced/rarely-used control, wrap it in an `AdvancedSection` next to the controls it relates to.
4. If it's operator/debug, put it behind the admin cog (`AdminToolsPanel`) — and gate it on `user.isAdmin`.

## History

The pre-2026-06 layout used a three-tab left sidebar (Filter / Plan / Tour) that became a left slide-over drawer on mobile, with the main flow surfaced as map FABs (Discover FAB, a `◀ Plan #N/M ▶` cluster row, and a tour-stats overlay). Debug overlays and the Cluster Lab were visible to all users; only the precompute panel was admin-gated. The overhaul folded the FABs' actions into the command-panel peek (one affordance per viewport), replaced the tabs with the journey rail, unified advanced disclosures into `AdvancedSection`, gated all debug tooling behind `user.isAdmin`, and fixed the map-interaction model (no incidental camera snapping; step-scoped click-to-set-center).
