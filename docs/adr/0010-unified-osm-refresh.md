# ADR-0010 — Unified OSM data refresh (drop daily landuse replication)

- **Status:** Accepted
- **Date:** 2026-05-27
- **Deciders:** Raimond Brookman (owner)
- **Amends:** [ADR-0009](0009-osm2pgsql-replaces-overpass.md) — supersedes the "daily replication" portion only; the osm2pgsql import path and `landuse_polygons` schema stay.

## Context

ADR-0009 introduced a `landuse-replication` BullMQ queue + processor + scheduler that was meant to apply Geofabrik minutely diffs to `landuse_polygons` daily, keeping the landuse data fresher than the OSRM walking graph.

In practice that turned into a no-op stub: the `osm2pgsql-replication` binary lives in the `osm2pgsql-import` container, not the api/jobs container, so the daily BullMQ processor only ever recorded a "heartbeat" string to `landuse_import_meta.replication_state` — it never actually applied a diff. The full replication wiring would have required either bundling osm2pgsql into the api image (heavy) or spawning the import container via the Docker API from the BullMQ processor (fragile).

Meanwhile, **OSRM has no incremental update path at all** — every refresh requires a full `osrm-extract` → `osrm-partition` → `osrm-customize` pass against a freshly-downloaded PBF. So even if the landuse half ran minutely, the walking-graph half would stay weekly-stale anyway, and the two halves would drift in their OSM-data-as-of timestamps.

Net assessment: the daily-diff design solved a problem (data freshness) that wasn't load-bearing for tour planning (landuse changes are slow), while making the operational story more complex (two distinct refresh cadences, two separate freshness counters in the admin UI, half-built BullMQ scaffolding).

## Decision

**Drop the `landuse-replication` BullMQ queue entirely.** Landuse and OSRM refresh together, on an operator-driven schedule, via a single shell script:

```
scripts/refresh-osm-data.sh
```

Steps the script performs end-to-end:

1. Wipe cached regional PBFs (so the next `osm-prep` pulls same-day downloads — see [infra/osrm/prep.sh](../../infra/osrm/prep.sh) for the cross-day caveat).
2. `docker compose run --rm osm-prep` — download + merge today's Geofabrik PBFs.
3. Wipe `.osrm.*` preprocessed files + recreate the `osrm` container → forces a full `osrm-extract`/`partition`/`customize` against the fresh PBF, blocks until osrm-routed is listening.
4. `LANDUSE_FORCE_REIMPORT=1 docker compose up osm2pgsql-import` — full landuse re-import against the same fresh PBF.

Wall-clock cost on the host8i7BEH:

| Region scope | Refresh time |
| ------------ | ------------ |
| NL alone     | ~12-15 min   |
| NL + NRW     | ~25-35 min   |

Recommended cadence: **weekly** via a host systemd timer (follow-up — out of scope for this ADR).

## What stays from ADR-0009

- The `osm2pgsql-import` compose service + Lua filter + Dockerfile.
- `landuse_polygons`, `landuse_import_meta` schema.
- The `cache_landuse` join + `populate_cache_landuse_in_bbox(...)` SQL function.
- `GET /admin/landuse/status` endpoint (read-only health view).

## What's removed

- `apps/api/src/jobs/landuse-replication/` (entire directory).
- `QUEUE_LANDUSE_REPLICATION` token + BullMQ queue registration + bull-board adapter entry.
- `POST /admin/landuse/reimport` endpoint + `LanduseReimportResponse` shared type.
- `landuse_import_meta.replicated_at` + `replication_state` are kept on the schema/wire for back-compat but always remain `null` until/unless a future incremental-update path is wired up.

## What's added

- [scripts/refresh-osm-data.sh](../../scripts/refresh-osm-data.sh) — the unified refresh.
- Eager `cache_landuse` populate in `WalkingPrecomputeProcessor`: after the route_legs work succeeds, the processor computes the bbox of in-scope caches and calls `populate_cache_landuse_in_bbox`. ~50-100 ms of PostGIS work that saves the equivalent on the first plan after upload, matches the eager pattern the walking-precompute already uses for `route_legs`. Best-effort — a failure here does not fail the precompute job (cache_landuse still gets the lazy fallback when the planner first asks).

## Alternatives considered (rejected)

- **Wire `osm2pgsql-replication` properly** — would mean either bundling osm2pgsql into the api image (~120 MB extra), or having the BullMQ processor spawn the import container via the Docker socket (security-sensitive). Both add operational surface for a freshness benefit (minutely → daily) that the planner doesn't perceive.
- **Daily landuse refresh, weekly OSRM refresh** — keeps two cadences. Avoidable.
- **Keep the BullMQ heartbeat as-is** — harmless but it muddies the architectural picture and the admin UI suggests "replication is happening" when nothing is.

## Consequences

**Good**

- One refresh story for the whole geo stack. Operator runs one script; both halves move to the same snapshot atomically.
- Drops ~150 lines of BullMQ scaffolding (queue/processor/scheduler/admin-button/zod schema) for a path that wasn't doing real work.
- `landuse_import_meta` becomes a single timestamp the admin panel can show ("OSM data as of …"), conceptually paired with `osrm-version.txt`.
- `cache_landuse` is eagerly populated on upload (via `WalkingPrecomputeProcessor`), matching the existing eager-precompute pattern — no first-plan latency penalty.

**Trade-offs**

- Landuse data freshness regresses from "could be minutely (in theory)" to "exactly as fresh as OSRM" (operator-chosen cadence; recommended weekly). Acceptable: landuse changes slowly enough that a week of staleness doesn't affect cluster scoring meaningfully.
- Manual refresh until a host systemd timer lands. Operators reading [docs/sdlc/release-and-deploy.md](../sdlc/release-and-deploy.md) will see this documented.

**Not in scope here**

- The host systemd timer / cron entry that calls `scripts/refresh-osm-data.sh` weekly. Out-of-repo (host-specific config).
- Walking-graph hot-reload (`osrm-routed` SIGHUP) — the refresh script restarts the osrm container instead. Hot reload is a runtime-availability optimisation that doesn't matter at single-tester scale.
