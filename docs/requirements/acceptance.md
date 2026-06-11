# Acceptance — end-to-end smoke (post-M6)

The full system is "shipped" when this scenario passes end-to-end on a clean machine:

1. `cp .env.example .env && docker compose up --build` — wait for OSRM preprocessing.
2. Open `http://localhost:5173`, register, log in.
3. Drag-drop a sample Groundspeak PQ GPX (≥ 50 caches).
4. Set center to a known cluster, radius 5 km. Hard filter type ∈ {Traditional, Multi} and attribute = "Dog allowed". Soft-prefer system profile "Forest hike day".
5. Verify map shows hard-filtered caches and the landuse toggle reveals polygons; forest caches score higher.
6. Click **Plan loop** with `distanceBudgetMeters=12 000`, `timeBudgetMinutes=240`.
7. Verify the result: closed polyline ≤ 12 km, ≤ 4 h, ≤ 20 caches; parking marker (PQ-provided preferred); score breakdown panel shown.
8. Save the tour. Reload the page. Tour and the chosen landuse profile re-render from the DB.
9. Share the saved tour (mint a link), then open `/shared/:slug` in a logged-out browser context: the read-only map + cache list render, with no owner identity and no edit/save controls. Revoke the share and confirm the link 404s.
10. CI is green: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm licenses:check`.
11. `docs/requirements/`, `docs/architecture/`, `docs/design/`, `docs/LICENSING.md`, and `CLAUDE.md` are present and current.
