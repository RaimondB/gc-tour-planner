# ADR-0009 — Replace self-hosted Overpass with osm2pgsql + PostGIS

- **Status:** Accepted (daily-diff path amended by [ADR-0010](0010-unified-osm-refresh.md))
- **Date:** 2026-05-27
- **Deciders:** Raimond Brookman (owner)
- **Supersedes:** [ADR-0008](0008-self-host-overpass.md)
- **Amended by:** [ADR-0010](0010-unified-osm-refresh.md) — the
  `landuse-replication` BullMQ queue was never load-bearing and is
  removed; refreshes are operator-driven via
  `scripts/refresh-osm-data.sh` in lockstep with OSRM.

## Context

[ADR-0008](0008-self-host-overpass.md) committed to a self-hosted Overpass sidecar (`wiktorn/overpass-api`) after public mirrors became unreachable, rate-limited, whitelist-only, or geographically broken. The decision was correct given the alternatives at that time, but the implementation has not held up on the 16 GB host8i7BEH:

- **Eight consecutive import attempts have failed**, each at ~47 min wall clock, each at the same point in `update_database` (just past OSM node ID 2.8 B). The kills produce **no cgroup OOM event, no kernel OOM event, no userspace OOM-daemon kill** in any journal. Deterministic but unobservable, even after hardening earlyoom's `--avoid` regex to cover `update_database|pbzip2|osmium`, raising the cgroup `mem_limit` from 4 → 8 GiB, growing swap from 4 → 16 GiB at priority 10, and tuning `vm.swappiness=10`.
- **Steady-state cost is 3 GB of RAM** that the Overpass dispatcher would hold continuously, on a host that's already at ~12 GB used + 4 GB swap before Overpass is even running.
- **We use ~5 % of what Overpass offers.** Our only consumer is `OsmService.findFeatures(bbox, kinds)` returning landuse polygons of 10 canonical kinds. We don't use the Overpass Query Language, the dispatcher's slot model, `out:json` query formats, multi-tenant rate limiting, or the diff-application machinery — capabilities the sidecar is built for and paying RAM/CPU/disk for.

ADR-0008 explicitly named `osm2pgsql` as a future direction worth its own ADR. The Overpass struggle validates that we should fast-track it.

## Decision

Remove the Overpass sidecar entirely. Import OSM landuse polygons directly into the existing Postgres+PostGIS database via **osm2pgsql with a flex-output Lua filter**, and serve `OsmService.findFeatures` from that table with regular Kysely + PostGIS queries.

### Architecture

- **One-shot compose service `osm2pgsql-import`** runs on first boot. Depends on `osm-prep: service_completed_successfully` and `postgres: service_healthy`. Reads the same Geofabrik NL PBF from the `osrm-data` volume (the share-with-OSRM win from ADR-0008 carries over). Invocation:

  ```
  osm2pgsql --slim --drop \
    --flat-nodes /var/lib/osm2pgsql/flat.bin \
    --cache 256 --number-processes 4 \
    --output=flex --style /srv/landuse.lua \
    /osrm-data/europe-netherlands-latest.osm.pbf
  ```

  Expected peak RAM ~1.5-2 GB; wall time ~30-40 min. Subsequent boots short-circuit (~2 s) when `landuse_import_meta.imported_at` is already populated.

- **Schema** (replaces `osm_landuse`):

  ```sql
  CREATE TABLE landuse_polygons (
    id BIGSERIAL PRIMARY KEY,
    osm_id BIGINT NOT NULL,
    osm_type CHAR(1) NOT NULL,            -- 'w' or 'r'
    kind TEXT NOT NULL,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL,
    UNIQUE (osm_type, osm_id)
  );
  CREATE INDEX landuse_polygons_geom_gix ON landuse_polygons USING GIST (geom);
  CREATE INDEX landuse_polygons_kind_idx ON landuse_polygons (kind);

  CREATE TABLE landuse_import_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    imported_at TIMESTAMPTZ NOT NULL,
    pbf_timestamp TIMESTAMPTZ,
    source_file TEXT
  );
  ```

  `area_hash`, `fetched_at`, `osm_source` columns go away. There's no longer a notion of per-cell freshness — the entire dataset refreshes atomically.

- **Lua filter** (`infra/osm2pgsql/landuse.lua`) is a direct port of [apps/api/src/osm/landuse-classify.ts](../../apps/api/src/osm/landuse-classify.ts) — the same kind-classification rules (`landuse=forest|park|residential|...`, `natural=wood|water|wetland|...`, `leisure=park|nature_reserve`).

- **Ongoing updates** via a new BullMQ queue `landuse-replication`, scheduled once daily at 04:00 (`cron: "0 4 * * *"`). The processor runs `osm2pgsql-replication update --database gctp ...` against Geofabrik's NL diff stream. Acquires a Postgres advisory lock, skips if `<12 h` since last successful run, writes a new metadata row on success.

- **Per-upload `overpass-refresh` job is removed.** Landuse data is region-scoped, not per-user-upload: once the NL extract is loaded, every new cache landing inside that region picks up landuse via the existing `populate_cache_landuse_in_bbox` SQL function during cluster planning. Upload-triggered refresh was a workaround for Overpass's cell-based laziness; with the whole region preloaded, it's redundant.

### Why this over the alternatives

| Aspect                              | Current Overpass (ADR-0008)                    | osm2pgsql (this ADR)                                                                | Imposm                         | Pre-build elsewhere    |
| ----------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------ | ---------------------- |
| Import peak RAM (NL)                | 5-8 GB (currently failing)                     | **1.5-2 GB** with `--slim --drop --flat-nodes`                                      | 2-3 GB                         | 0 on host              |
| Import wall clock                   | 45-60 min, unstable                            | ~30-40 min, deterministic                                                           | 20-30 min                      | LAN transfer time only |
| **Steady-state RAM**                | **~3 GB** (dispatcher)                         | **~0 incremental** (rides on existing Postgres)                                     | ~0 incremental                 | unchanged              |
| **Steady-state CPU**                | dispatcher idle + per-query                    | shared with Postgres, indexed bbox <100 ms                                          | same                           | unchanged              |
| Lua flexibility for 10-kind mapping | n/a                                            | ✅ direct port of [landuse-classify.ts](../../apps/api/src/osm/landuse-classify.ts) | ❌ YAML mapping, less flexible | n/a                    |
| Update path                         | Geofabrik diffs in image                       | `osm2pgsql-replication` daemon                                                      | bespoke cron                   | re-build + rsync       |
| Licence (server / tool)             | AGPL-3.0 (HTTP boundary)                       | GPL-2.0 (compatible)                                                                | Apache-2.0                     | inherits primary tool  |
| Containers / volumes added          | +1 service, +1 healthcheck, +1 port, +1 volume | 1 one-shot job, +1 small volume                                                     | same                           | 0                      |
| Per-feature blast radius            | dispatcher down = no landuse                   | Postgres outage = same as for caches                                                | same                           | same                   |

The decisive factors are **steady-state RAM** (we reclaim ~3 GB on the host, immediately usable by the existing Postgres / OSRM / API caps) and **stability** (osm2pgsql has a well-understood, deterministic memory profile that doesn't need exotic kernel tuning to survive on 16 GB). Imposm is faster on import but YAML-driven mapping is awkward for our `landuse|natural|leisure` precedence rules. Build-elsewhere doesn't solve the steady-state cost.

## Alternatives considered (and rejected)

- **Persist with Overpass + more host tuning.** We've already exhausted the cheap knobs: earlyoom `--avoid`, swap growth, swappiness, cgroup cap bumps. The kills continue with no observable cause. Continuing to throw RAM at it is a poor use of the pending 64 GB upgrade — that RAM is better spent on growing the OSRM / Postgres / Solver workspaces, not on a tool we're using 5 % of.
- **Pre-build the Overpass DB on a developer machine and rsync to host.** Solves the import-failure problem but leaves us paying ~3 GB of RAM for the dispatcher at steady state. Doesn't address the architectural mismatch (Overpass is too much tool for too little use).
- **Imposm.** Faster import; equivalent runtime. Loses Lua flexibility, which we'd want for the `landuse|natural|leisure` tag precedence and any future kind additions. Saves ~10 min on a one-time operation — not worth the tooling tradeoff.
- **Tilemaker / vector tiles.** Wrong tool: produces tiles for rendering, not queryable polygon data.

## Consequences

**Good**

- **Reclaims ~3 GB RAM** that was earmarked for Overpass dispatcher. Frees the host from a chronic memory shortage and removes the immediate motivation for the 64 GB upgrade (we still want it eventually for OSRM/Postgres headroom, but it stops being urgent).
- **Stops the OOM-of-the-week tuning game.** osm2pgsql with `--slim --drop --flat-nodes` is designed for memory-constrained hosts.
- **Simpler operational model.** One less service, healthcheck, volume, port, network exposure, and licence surface. `landuse_polygons` becomes a regular table the rest of the API treats the same as `caches` or `route_legs`.
- **Same Lua-driven classification** as our existing TS classifier — single source of truth for "what counts as a forest", just declared in two languages.
- **Diff-based updates stay automated** via `osm2pgsql-replication` + a BullMQ daily job. Operator gets a `/admin/landuse/status` panel and bull-board for failures.

**Trade-offs**

- **First-boot wall clock is the same** (~30-40 min for NL). osm2pgsql doesn't beat Overpass on first-import time; it beats it on stability and on steady-state cost.
- **One-shot data migration**: the `osm_landuse` table is dropped. Re-population happens automatically on the next compose-up via the new `osm2pgsql-import` service. No backup is needed because the data is regenerable from the canonical PBF.
- **`/admin/precompute/summary` loses its per-cache `kind=landuse` breakdown.** Replaced by a simpler `GET /admin/landuse/status` showing one timestamp + last replication-job result. This is actually a clearer UX — landuse was always atomic-by-region rather than per-cache.
- **The Lua filter is a second copy of the kind-classification rules**, alongside [apps/api/src/osm/landuse-classify.ts](../../apps/api/src/osm/landuse-classify.ts). Adding a new kind requires updating both. The Lua file should reference the TS file in a header comment; a unit test compares the two lists at runtime to catch drift.
- **License-checker scope changes**: we drop the AGPL-3.0 Overpass-server boundary (ADR-0008 §3.9 in LICENSING.md) and add a GPL-2.0 osm2pgsql sidecar. GPL-2.0 is GPLv3-compatible (we link via HTTP and via a one-shot binary invocation, not statically) so the check remains green.
- **Operator runbook changes.** `docker compose run --rm osm2pgsql-import` becomes the way to force a re-import. `POST /admin/landuse/reimport` is the user-facing button.

**Not in scope here**

- Multi-region support. Default is still `OSRM_REGION=europe/netherlands`. Operators outside NL update both `OSRM_REGION` and (if they want a different PBF source) `LANDUSE_PBF_SOURCE`. Multi-region merging is rare and can be a follow-up.
- Moving the broader OSM data (roads, POIs, addresses) into Postgres. We're only doing landuse here — OSRM keeps its own preprocessed graph, and we have no current consumer for the rest of the OSM data.
- Vector tile generation. If the web map ever wants to render the same landuse polygons client-side, the `landuse_polygons` table makes that easy via Martin or `pg_tileserv` — but that's a future ADR.
