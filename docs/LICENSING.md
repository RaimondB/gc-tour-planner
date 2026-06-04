# Licensing

This project is licensed under **GPL-3.0-or-later** ([LICENSE](../LICENSE)). This file documents what that means in practice for dependencies, data sources, and assets.

Architectural rationale: [ADR-0003](adr/0003-license-gplv3.md).

## 1. Why GPLv3

The user (project owner) chose GPLv3 deliberately to keep downstream derivatives open. A more permissive license (MIT/Apache-2.0) was considered and rejected — the project relies on several copyleft data sources (notably OSM ODbL) and on the GPLv3 ecosystem (PostGIS GPL-2.0+), and the owner wants modifications to stay public.

## 2. Hard compatibility rules

These are not suggestions — CI enforces them.

### 2.1 Runtime dependencies

Every direct and transitive runtime dependency must be **GPLv3-compatible**. Acceptable: GPL-2.0+ / GPL-3.0+ / LGPL / Apache-2.0 / MIT / BSD / ISC / Unlicense / CC0. **Not acceptable**: SSPL, RSAL, Commons Clause, Confluent Community License, BUSL (until conversion), CC-BY-NC, anything proprietary.

CI runs a license-checker step that fails on the disallowed list. Adding a dep with an unknown license requires either an ADR explaining why it's compatible or replacing the dep.

### 2.2 Build-only and dev dependencies

Same rules — even build tools must be GPL-compatible because the project's build output is GPLv3.

### 2.3 Source-file headers

Every TypeScript / JavaScript / SQL source file in `apps/` and `packages/` gets a GPLv3 header:

```
// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
```

(Configuration files, ADRs, READMEs, and migrations are exempt; the repo LICENSE covers them.)

## 3. Specific decisions

### 3.1 Valkey, not Redis

Redis 7.4+ ships under SSPL/RSAL, which **is not GPL-compatible**. The project uses **Valkey** (BSD-3-Clause), the Linux Foundation fork. See [ADR-0004](adr/0004-valkey-over-redis.md).

### 3.2 No Groundspeak attribute icons

Groundspeak's attribute icons (the round badge images) are copyrighted by Groundspeak and not redistributable. The web UI uses **Material Symbols** (Apache-2.0) or text chips instead. Never check Groundspeak icons into this repo.

### 3.3 OpenStreetMap data (ODbL)

OSM data is licensed under **ODbL 1.0**. ODbL is compatible with GPLv3 for our use (we consume the data, not relicense it). Obligations we comply with:

- **Attribution on every map view**: "© OpenStreetMap contributors". Implemented as a permanent MapLibre attribution control.
- **Attribution page** at `/attribution` listing: OpenStreetMap (ODbL), osm2pgsql (GPL-2.0+), OSRM (BSD-2-Clause), MapLibre GL JS (BSD-3-Clause), the chosen tile provider.
- **Share-alike for derived databases**: `osm_landuse` rows are an ODbL-derived database. If we ever publish that table as a dataset, it must be released under ODbL. We currently only serve query results, which is allowed without relicensing.

### 3.4 Geocaching.com / Groundspeak data

Cache data on geocaching.com is **proprietary to Groundspeak**. This project does **not** ingest, store, or redistribute Groundspeak data centrally. Two pathways exist for the user to bring data in:

- **GPX uploads** (MVP). The user supplies their own Pocket Query GPX. Stored rows are **per-owner row-level isolated** — never exposed across users.
- **GC.com partner API adapter** (M8, feature-flagged off). When/if Groundspeak grants partner access, the adapter uses a single shared partner key from env, respects rate limits + caching rules per partner agreement, and stays subject to Groundspeak ToS. The project does **not** store per-user Groundspeak credentials.

If the project is forked and deployed, the operator is responsible for their own Groundspeak ToS compliance. This file is informational, not a license grant for Groundspeak data.

### 3.5 OKAPI (OpenCaching)

Various OKAPI nodes (oc.de, oc.pl, oc.nl, etc.) expose cache data under varying terms (typically CC-BY-SA-3.0 or compatible). The OKAPI adapter (M7) will:

- Record the source node id (`source='okapi:de'`, etc.) so attribution can be rendered correctly.
- Honor each node's `consumer_key` requirement (env-injected, no per-user keys).

Per-node license metadata is documented in the OKAPI source adapter README (to be added in M7).

### 3.6 OSRM and routed network data

OSRM is **BSD-2-Clause** — compatible. The OSM extract OSRM is preprocessed from is ODbL — see §3.3 above.

### 3.9 osm2pgsql import + osmium-tool (GPL-2.0+) — ADR-0009

We import landuse polygons from a Geofabrik PBF into the project's
Postgres via [osm2pgsql](https://github.com/osm2pgsql-dev/osm2pgsql)
(GPL-2.0+) and [osmium-tool](https://github.com/osmcode/osmium-tool)
(GPL-3.0+) — both run in the one-shot `osm2pgsql-import` compose
service ([infra/osm2pgsql/Dockerfile](../infra/osm2pgsql/Dockerfile)). See
[ADR-0009](adr/0009-osm2pgsql-replaces-overpass.md) for the why; this
section covers the licensing posture.

GPL-2.0+ and GPL-3.0+ are both GPLv3-compatible:

- We invoke them as **separate processes** from a one-shot container — no
  static or dynamic linking from our TypeScript code. The interface is
  the command line + the resulting Postgres tables.
- We don't modify osm2pgsql or osmium. If we ever fork either to patch
  upstream behaviour (rather than configure via Lua), those patches MUST
  ship under the same license as the modified project (GPL-2.0+ /
  GPL-3.0+).
- The Lua filter [infra/osm2pgsql/landuse.lua](../infra/osm2pgsql/landuse.lua)
  is our own code under GPL-3.0-or-later; it's consumed by osm2pgsql as
  configuration data, not linked.

Previous setup (Overpass sidecar, AGPL-3.0 via wiktorn/overpass-api) was
documented here under ADR-0008 and is **superseded** by ADR-0009. The
AGPL §13 network-clause concerns from that note no longer apply because
no AGPL code runs at request time anymore.

The license-checker (`pnpm licenses:check`) only scans the Node.js
dependency graph, so neither osm2pgsql nor osmium-tool appears there.
The audit trail lives in this file and in ADR-0009.

### 3.7 Tile sources

The default tile source is **TBD** and will be documented here once chosen. Constraints:

- Compatible with our usage scale.
- ODbL attribution displayed.
- Reasonable terms for an open-source project.

Candidates considered: MapTiler (free tier with attribution), Stadia Maps, Stamen, self-hosted via openmaptiles. Self-hosted is the long-term answer; a free tier with attribution is the MVP path.

### 3.8 Fonts and icons

- **Material Symbols** (Apache-2.0) — primary icon set.
- **Inter** font (OFL 1.1) — UI font.
- No icon or font sourced from a proprietary tracker (Font Awesome Pro, Stripe, etc.).

## 4. Contributor expectations

By contributing a PR you agree your contribution is licensed under GPL-3.0-or-later. We don't require a CLA. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## 5. Audit hook

CI step (defined in `.github/workflows/ci.yml`):

```yaml
licenses:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v3
    - run: pnpm install --frozen-lockfile
    - run: pnpm dlx license-checker --production --failOn 'SSPL;RSAL;BUSL-1.1;CC-BY-NC-4.0;Commons-Clause;Confluent Community License' --summary
```

When this fails, **don't skip the check**. Either replace the offending dep, or open an ADR documenting why it's actually compatible (the license-checker is occasionally wrong about SPDX identifiers).

## 6. Quick reference

| Item              | License                       | Action                                                          |
| ----------------- | ----------------------------- | --------------------------------------------------------------- |
| This project      | GPL-3.0-or-later              | LICENSE at repo root, header on every source file               |
| OSM data          | ODbL 1.0                      | Map attribution + `/attribution` page                           |
| OSRM              | BSD-2-Clause                  | Listed on `/attribution`                                        |
| osm2pgsql         | GPL-2.0+                      | One-shot import + replication sidecar (§3.9, ADR-0009)          |
| osmium-tool       | GPL-3.0+                      | Same container as osm2pgsql, used for PBF metadata reads (§3.9) |
| MapLibre GL JS    | BSD-3-Clause                  | Listed on `/attribution`                                        |
| Valkey            | BSD-3-Clause                  | Use instead of Redis                                            |
| PostGIS           | GPL-2.0+                      | Compatible                                                      |
| Postgres          | PostgreSQL License (MIT-like) | Compatible                                                      |
| Material Symbols  | Apache-2.0                    | Icons                                                           |
| Inter font        | OFL 1.1                       | UI font                                                         |
| Groundspeak data  | Proprietary                   | User-uploaded only, per-owner isolated                          |
| Groundspeak icons | Proprietary                   | **Never bundled**                                               |
