# ADR-0027 — Lucide as the app-wide UI icon set

- **Status:** Accepted
- **Date:** 2026-06-15
- **Deciders:** Raimond Brookman (owner)
- **Related:** [CLAUDE.md hard rules](../../CLAUDE.md) (no bundled Groundspeak icons; GPLv3-compatible deps)

## Context

The web app grew icons ad hoc: Unicode glyphs in chrome controls (`⚙` admin,
`⊕` frame-view, `💾` save, `↓` GPX), JourneyRail markers (`🔒` locked, `✓`
done), and hand-rolled inline SVGs (the brand `Logo`, the cache-attribute
`AttributeIcon` set, the new My-Tours pencil/trash). Emoji glyphs render
inconsistently across platforms (colour/sizing/baseline vary by OS font) and
don't inherit `currentColor`, so they can't be themed with the surrounding
control. There was no single, consistent vocabulary.

The obvious "consistent icons everywhere" reflex is an icon **font** (Material
Symbols is name-checked in CLAUDE.md as a licence-safe option). But this repo
deliberately avoids an icon font — the `AttributeIcon` header spells out the
rationale: keep the bundle lean and render on first paint with no font load.
Self-hosting (we ship no external CDNs, for privacy/offline) the full Material
Symbols variable font is multiple MB; doing it properly means subsetting to the
used glyphs — non-trivial build tooling for the ~10 icons we actually use.

## Decision

**Adopt [Lucide](https://lucide.dev) via `lucide-react` as the standard UI icon
set.** Lucide ships each icon as a tree-shaken React component rendering an
inline `<svg>` with `stroke="currentColor"` — so only imported icons enter the
bundle, there is **no font and no CDN**, and icons inherit the control's colour
and size. This is fully consistent with the existing "inline SVG, no font"
approach (`AttributeIcon`, `Logo`) — it just gives us a large, coherent
vocabulary instead of bespoke paths per need.

- **Dependency:** `lucide-react` (**ISC** licence — permissive, GPLv3-compatible,
  satisfies the LICENSING hard rule). Added to `apps/web` only.
- **Usage:** import the specific icon (`import { Pencil } from "lucide-react"`),
  size via the `size` prop or CSS, colour via `currentColor`. Icon-only buttons
  MUST carry an `aria-label` (+ `title`); decorative icons get `aria-hidden`.
- **Migrated in the first sweep (app chrome):** the My-Tours rename/delete
  buttons (`Pencil`/`Trash2`), the header admin/frame/save/GPX glyphs, and the
  JourneyRail locked/done markers.

**Deliberately out of scope (stay as-is):**

- The brand **`Logo`** — it's a bespoke wordmark/monogram, not a generic icon.
- The domain **`AttributeIcon`** set — cache-attribute → icon is a curated
  semantic mapping (FR-SF3/4/8) that renders with `fill="currentColor"`; it is
  already inline-SVG and font-free, so it shares Lucide's rationale. Reconciling
  each attribute to a Lucide glyph is a design exercise tracked as a follow-up,
  not a mechanical swap.
- Textual affordance arrows in labels (e.g. "Find clusters →") — these are
  punctuation in copy, not icon controls.

## Consequences

- **Consistent, themeable icons** across the chrome; they scale crisply and
  follow the control's colour/disabled state (no more emoji platform drift).
- **Bundle stays lean:** tree-shaking means only the handful of imported icons
  ship; no font payload, no external request.
- **One licence to track** (`lucide-react`, ISC) — `pnpm licenses:check` covers
  it in CI.
- **Two icon systems coexist intentionally** for now: Lucide for generic UI,
  `AttributeIcon` for the cache-attribute domain. The follow-up may fold
  `AttributeIcon` onto Lucide where a faithful glyph exists, keeping bespoke
  paths only where Lucide has no good match.

## Alternatives considered

- **Material Symbols font (CDN):** easiest to adopt but adds an external runtime
  dependency — rejected on the no-CDN / privacy / offline grounds the rest of
  the stack already follows (self-hosted maps, OSRM, fonts).
- **Material Symbols font, self-hosted + subset:** keeps it on-box but needs
  font-subsetting build tooling and still ships a font for ~10 icons — more
  machinery than an inline-SVG set for no real benefit here.
- **Keep hand-rolling SVGs per icon:** zero new dependency, but every new icon
  is bespoke work and the set drifts in style — the inconsistency this ADR
  exists to remove.
