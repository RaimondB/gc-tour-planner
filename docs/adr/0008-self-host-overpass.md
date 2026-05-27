# ADR-0008 — Self-host Overpass as a compose sidecar

- **Status:** Superseded by [ADR-0009](0009-osm2pgsql-replaces-overpass.md)
- **Date:** 2026-05-26
- **Deciders:** Raimond Brookman (owner)
- **Superseded on:** 2026-05-27

> **Superseded note (2026-05-27):** the Overpass sidecar described below
> proved impossible to bootstrap on the 16 GB NUC8i7BEH — eight
> consecutive imports were killed mid-`update_database` with no
> observable cause (no cgroup OOM, no kernel OOM, no userspace
> OOM-daemon kill). ADR-0009 replaces this approach with `osm2pgsql`
> writing landuse polygons directly into the existing Postgres+PostGIS
> database. The PBF-share-with-OSRM design and the dev-shares-with-UAT
> pattern from this ADR carry over.

## Context

[ADR-0007](0007-precompute-walking-paths-on-upload.md) made landuse polygons a first-class precompute input: every GPX upload enqueues an `overpass-refresh` job that warms `osm_landuse` cells via the public Overpass API. The runtime soft-preference scoring (M5-β) and the admin "retrigger stale" sweep both depend on those cells being populated.

A retrigger-stale exercise on 2026-05-26 surfaced that **no public Overpass mirror is usable from the project's dev/UAT network**:

| Mirror                          | Result                                                             |
|---|---|
| `overpass-api.de`               | IPv4 RST on connect (Hetzner subnet appears blocked upstream of this network); IPv6-only DNS otherwise and the host's ISP has no IPv6. |
| `overpass.osm.ch`               | HTTP 200 with `elements: []` for every Dutch bbox — serves a Switzerland-only extract.                                                  |
| `overpass.openstreetmap.fr`     | HTTP 403 "This service is only available to white-listed usages."  |
| `overpass.kumi.systems`         | Connect timeout from this network.                                 |
| `overpass.private.coffee`       | Connect timeout from this network.                                 |
| `maps.mail.ru/osm/tools/...`    | Connect timeout from this network.                                 |
| `lz4.overpass-api.de`, `z.overpass-api.de`, `gall.openstreetmap.de` | Same RST as the main `overpass-api.de`. |

Even when a mirror *is* reachable, the public-mirror fair-use policy (≈2 concurrent slots/IP) caps the precompute fan-out. The retrigger-stale workflow batches 50 caches per job, each of which can touch a dozen-plus cells; honouring `OVERPASS_MAX_PARALLEL=2` (added 2026-05-26) means a full owner re-warm serialises through a stranger's server.

This is brittle architecture for a non-trivial feature path. Landuse precompute is now load-bearing for the soft-preference scoring story; it can't depend on the goodwill of a public service we can't reach.

## Decision

Add a **self-hosted Overpass instance as a compose sidecar**, modelled on the OSRM and Timefold sidecars already in the stack.

- **Image:** `wiktorn/overpass-api` (well-maintained, Docker-first wrapper around `drolbr/Overpass-API`, the canonical implementation; AGPL-3.0 — compatible with our GPLv3 license per [LICENSING.md §2](../LICENSING.md#2-hard-compatibility-rules) because the Overpass server runs as a separate process accessed over HTTP, not linked into our binary).
- **Extract:** Netherlands, by default reusing the PBF that OSRM's `osm-prep` service already downloads into the `osrm-data` volume (`file:///osrm-data/europe-netherlands-latest.osm.pbf`). Saves ~1 GB of download + ~10 min wall-clock vs. fetching Geofabrik a second time. Operators wanting Overpass to cover a different region than OSRM override `OVERPASS_PLANET_URL` in their `.env` to a direct Geofabrik URL. Overpass is gated on `osm-prep: service_completed_successfully` so the file exists when it first boots.
- **Update channel:** Geofabrik daily diffs (`OVERPASS_DIFF_URL=https://download.geofabrik.de/europe/netherlands-updates/`). The image's built-in `dispatcher`/`fetch_osc.sh` applies minutely-style diffs continuously.
- **Service name:** `overpass`, defined **only in the UAT compose file** ([infra/docker-compose.yml](../../infra/docker-compose.yml)). Exposes `:80` inside compose; published as `:5001` on the host.
- **Dev shares UAT's Overpass — same pattern as OSRM.** [CLAUDE.md] already enforces this for OSRM ("OSRM is shared with UAT — a second OSRM instance OOMs the NUC"). Overpass has the same RAM-and-cold-start cost profile (~3 GB RAM + ~30 min initial PBF import), and the same read-only-HTTP risk profile from dev's perspective. Running a second Overpass for dev would double both the RAM bill on the NUC and the cold-start time on `pnpm dev:down && pnpm dev`, with no upside. Dev points at the UAT instance via the already-published host port `:5001`. `scripts/dev.env.example` gains an `OVERPASS_URL_DEV` knob mirroring the existing `OSRM_URL_DEV`.
- **Wire change:** `OVERPASS_URL` defaults to `http://overpass:80/api/interpreter` inside the UAT compose network; `http://localhost:5001/api/interpreter` from a dev API process on the host. Per-machine override via `scripts/dev.env` still works for anyone who wants to point at a different mirror.
- **Concurrency cap raised** for the self-hosted endpoint: `OVERPASS_MAX_PARALLEL=8` (a single self-hosted instance trivially handles single-digit parallel slot usage; the public-mirror politeness floor of 2 doesn't apply). Dev inherits the same cap by virtue of pointing at the same instance.

The existing `OsmService` + `overpass-refresh` BullMQ machinery is unchanged — it already talks to whatever endpoint `OVERPASS_URL` points at.

## Why `wiktorn/overpass-api`

- Active maintenance (releases through 2025), tracks upstream `drolbr/Overpass-API`.
- Handles initial PBF download, area-import, and dispatcher start in a single entrypoint — same UX shape as our OSRM sidecar's bootstrap.
- Built-in diff-fetcher: no separate cron, no host-side script.
- Healthcheck-friendly (`/api/status` returns slot availability text).
- AGPL-3.0 on the server itself; the Docker image's wrapping scripts are MIT. The AGPL network clause is satisfied — we'd publish our compose configuration with the rest of the GPLv3 repo, and users can replace the Overpass image with their own build.

## Alternatives considered

- **Stick with public mirrors + better error handling.** Rejected above: there is no public mirror this network can both reach and that serves the right geography.
- **Use a tunnel broker (Hurricane Electric 6in4) to reach `overpass-api.de` over IPv6.** Solves the IPv6 reachability problem for the dev network but doesn't address the rate-limit, the whitelist mirror, or future UAT/prod hosts. Adds an infrastructure dependency for a workaround that only helps one symptom.
- **Replace Overpass with `osm2pgsql` + direct PostGIS queries.** Strictly better long-term — landuse becomes a regular table in our own DB, no HTTP, no sidecar, queryable with Kysely. Rejected for now because it's a much bigger architectural change: a one-off planet/extract import, an `osm2pgsql-replication` daemon, schema-discipline decisions (default schema vs. flex output), and a rewrite of the entire `OsmService` cells/staleness model. Captured here as a deliberate **future direction** worth a separate ADR (likely alongside M5 or M8) — this ADR only commits to unblocking the immediate breakage.
- **`mediagis/overpass-api` image.** Fork of `wiktorn/overpass-api`, slightly slimmer. Less active. No advantage worth the lower bus factor.
- **Bundle Overpass into the `api` image as a co-process.** Bloats the API image, couples API rolling-restarts to a 10 GB DB, kills the "API is stateless" property. The sidecar pattern (already used for OSRM, Timefold) is the right shape.
- **Run a separate Overpass for the dev compose project.** Rejected — same reasoning as OSRM in [CLAUDE.md](../../CLAUDE.md): the second instance OOMs the NUC and duplicates a 30-min cold start for no benefit. Dev's Overpass calls are read-only HTTP just like OSRM, no data risk to UAT.

## Consequences

**Good**

- `overpass-refresh` jobs become reliable. Precompute throughput stops being capped by a stranger's fair-use policy; `OVERPASS_MAX_PARALLEL=8` lets a 50-cache batch warm in seconds instead of minutes.
- Removes a runtime dependency on services outside our control. Fewer flaky-CI / flaky-UAT modes.
- Sets the precedent (and the pattern) for the eventual `osm2pgsql` migration: any team member who's worked on the sidecar will recognise the shape of the bigger change.
- Bootstrap-from-PBF pattern is already familiar (OSRM does the same thing). Documentation can cross-reference rather than reinvent.

**Trade-offs**

- **+~12 GB volume** for the NL extract DB (`overpass_db` volume in compose, UAT only — dev shares). Planet would be ~150 GB — out of scope.
- **+~3 GB RAM** when warm, paid **once** on the NUC because dev shares UAT's instance. Fits comfortably alongside Postgres/Valkey/OSRM.
- **+~30 min first-boot** to import the PBF (similar wall-clock cost to OSRM preprocessing; the two run sequentially because Overpass `depends_on: osm-prep`, not in parallel — the PBF is shared). Dev never re-pays this cost.
- **Region coupling:** Overpass and OSRM by default share the same Geofabrik extract via the `osrm-data` volume. Setting `OSRM_REGION` to something other than `europe/netherlands` requires `OVERPASS_PLANET_URL` to be updated to match (or pointed back at a Geofabrik URL to download independently). This is desirable — landuse precompute and walking precompute should cover the same geographic scope — but worth being explicit about.
- **Daily diff bandwidth** ~5 MB/day for NL. Negligible.
- **One more service to monitor.** Add an Overpass row to the `/admin/jobs` summary or to whatever ops dashboard we settle on. Failure mode: dispatcher crash → 503s → BullMQ retries → admin sees failed jobs.
- **License audit:** AGPL-3.0 on the server adds a new SPDX to `pnpm licenses:check`. Network-service clause is satisfied by publishing our compose config in the public GPLv3 repo. Updated [LICENSING.md] needed.
- **Docs change:** [docs/sdlc/dev-stack.md] gains an "Overpass" section; [docs/PLANNER_TUNING.md] notes the raised `OVERPASS_MAX_PARALLEL` default for self-hosted; [docs/architecture/](../architecture/) gets an architecture-diagram update showing the new sidecar.

**Not in scope here**

- The `osm2pgsql` migration. Recorded as future direction above; will need its own ADR before any code lands.
- Multi-region extracts. The default scope is NL; operators outside NL set `OVERPASS_PBF_URL` themselves. We'll revisit if/when a second deployment region becomes real.
- Removing the `OVERPASS_URL` knob. Keeping the indirection lets contributors point at a personal public mirror (if they have credentials), and gives us a smooth swap path when the eventual `osm2pgsql` adapter lands behind the same `OsmService` interface.
- An automated PBF-version freshness check in the `/admin/jobs` summary. Geofabrik diffs are minutely; for now we trust them. Add a "PBF age" tile if drift becomes a real concern.
