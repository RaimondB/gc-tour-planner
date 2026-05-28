# Non-functional requirements

Cross-cutting properties the system must hold regardless of feature surface.

- **NFR-1 (Type safety).** Shared zod schemas between client and server (`packages/shared`); no duplicated DTO definitions.
- **NFR-2 (Reproducible dev env).** `cp .env.example .env && docker compose up --build` brings the full stack up (postgres+postgis, valkey, osrm, api, web, jobs). First boot may take ~10 minutes for OSRM preprocessing — subsequent boots are fast.
- **NFR-3 (Performance).** Filtered cache search over 10 000 caches in a 25 km radius returns in < 500 ms on developer hardware (PostGIS GIST index + clustered indexes).
- **NFR-4 (Determinism).** The greedy planner is deterministic for a fixed input (no random tie-breaks).
- **NFR-5 (License compliance).** All runtime + build dependencies must be GPLv3-compatible. CI runs a license checker that fails on incompatible licenses. See [../LICENSING.md](../LICENSING.md) and [ADR-0003](../adr/0003-license-gplv3.md).
- **NFR-6 (Data ownership).** User-uploaded GPX is per-owner row-level isolated; no global cross-user leakage of Groundspeak data.
- **NFR-7 (Testability).** Unit tests for pure functions (GPX parsing, TSP, clustering, filter SQL builder); integration tests with real PostGIS via Testcontainers; Playwright E2E exercises the upload → plan → save loop.
- **NFR-8 (International).** No NL-only assumptions in schema, APIs, or UX. The OSRM region is configurable; the user chooses which extract to preprocess.
- **NFR-9 (Multi-tenant reliability under load).** A single tenant must not be able to take down the stack by stress-testing the planner. Three guardrails apply in production:
  - `HttpOsrmClient` has a global semaphore (`OSRM_MAX_CONCURRENCY`, default 8) — surplus requests queue rather than reject; OSRM-routed gets `--threads` (`OSRM_THREADS`, default 4). See [../design/routing-osrm.md](../design/routing-osrm.md).
  - Postgres `shm_size` is raised to 1 GiB (512 MiB on dev) so parallel workers don't blow through Docker's 64 MiB `/dev/shm` default — the failure mode was `could not resize shared memory segment` 502s.
  - API container `mem_limit` is 2 GiB to give V8 headroom for the worst-case `/landuse` response. Server-side `LIMIT 5000` (ordered by envelope area desc) is the final safety net.
