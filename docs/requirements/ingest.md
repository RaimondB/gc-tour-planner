# Requirements — Cache ingest

How caches enter the system. Cross-references: [design/data-model.md](../design/data-model.md) for the `caches` schema; [design/gpx-parsing.md](../design/gpx-parsing.md) for the parser.

- **FR-I1.** Accept GPX upload via the web UI. Parse Groundspeak Pocket Query extensions (`groundspeak:cache`, `groundspeak:attributes`, `groundspeak:short_description`, `groundspeak:long_description`) **and** generic GPX waypoints.
- **FR-I2.** Identify and store **additional waypoints** with `type='parking'` (Groundspeak `<sym>Parking Area</sym>`) per cache.
- **FR-I3.** Upsert by `(source, source_id)` so re-uploading a refreshed PQ updates instead of duplicating.
- **FR-I4.** Per-user row-level isolation: a user only sees caches they uploaded (or that came from a public source adapter).
- **FR-I5 (M7).** Optional **OKAPI** source adapter for OpenCaching nodes, queryable by bbox.
- **FR-I6 (M8, feature-flagged off).** GC.com partner-API adapter — single shared partner key from env; never per-user creds in DB.
- **FR-I7 (record finds).** The user can record which caches they have found, via two paths:
  - Uploading a Groundspeak **"My Finds"** Pocket Query GPX — every cache in the upload is also marked as found by the current user (idempotent; re-uploading does not duplicate).
  - **Manual mark / unmark** from the map popup of any cache they own. Finds are per-user; another user does not see them.
- **FR-I8 (precompute on upload).** GPX upload completion triggers two background jobs, fire-and-forget from the upload handler's perspective: `walking-precompute` (OSRM `/table` for each new cache's top-k haversine neighbours within 3 km + re-runs k-NN for affected existing caches, persists to `route_legs`) and `overpass-refresh` (landuse around the new caches' convex hull into `osm_landuse`). Uploads must not block on precompute. Per-cache freshness is tracked in `cache_precompute_state` so stale rows can be retriggered without purging the whole cache. See [ADR-0007](../adr/0007-precompute-walking-paths-on-upload.md) and [design/precompute.md](../design/precompute.md).
