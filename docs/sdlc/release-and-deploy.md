# Release + deploy

## Local dev loop

```
pnpm install        # one-shot bootstrap
pnpm dev            # dev infra in compose + api+web local with hot reload
# Ctrl-C stops api+web; infra keeps running
pnpm dev:down       # stop dev infra (volumes preserved)
```

`pnpm dev` is a thin wrapper around [scripts/dev.sh](../../scripts/dev.sh) that:

1. Sources `scripts/dev.env` if present (defaults used otherwise — see [scripts/dev.env.example](../../scripts/dev.env.example)).
2. Brings up dev infra (`postgres`, `valkey`) via [infra/docker-compose.dev.yml](../../infra/docker-compose.dev.yml) under compose project name **`gctp-dev`** with host ports shifted **+10000** from UAT defaults:
   - postgres `localhost:15432`
   - valkey `localhost:16379`
3. **OSRM is shared with UAT** (`http://localhost:5000`, UAT's host-published port). Running a second OSRM instance OOMs the host — the NL-foot extract peaks at ~5-6 GiB during preprocessing and UAT already holds 8 GiB of the 16 GiB host. Dev only makes read-only HTTP calls; no risk to UAT data. Override via `OSRM_URL_DEV` if your UAT runs OSRM elsewhere.
4. Refuses to start if `API_PORT_DEV=3000` (another service on the host owns 3000).
5. Probes the OSRM URL (non-fatal): warns if unreachable. Planner endpoints 500 until UAT's OSRM is up; everything else (uploads, filtering, map markers, admin) works regardless.
6. Waits for postgres health (~5 s).
7. Runs any pending migrations via `pnpm --filter @gctp/db migrate:up`.
8. Launches api on `localhost:3030` and web on `localhost:5173` in parallel with interleaved `[api]`/`[web]` logs.
9. `Ctrl-C` cleans up api+web. Infra stays up.

### Separation from UAT

The dev stack runs in its own compose project with its own state. The one deliberate exception is OSRM, which is shared read-only.

| Concern            | UAT                                                                                                            | Dev                                                                  | Shared?             |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------- |
| Compose project    | `gctp`                                                                                                         | `gctp-dev`                                                           | no                  |
| Compose file       | `infra/docker-compose.yml`                                                                                     | `infra/docker-compose.dev.yml`                                       | no                  |
| Postgres host port | 5432                                                                                                           | 15432                                                                | no                  |
| Valkey host port   | 6379                                                                                                           | 16379                                                                | no                  |
| OSRM               | container, port 5000                                                                                           | **same container** via host:5000                                     | **YES (read-only)** |
| API host port      | none (only `web` nginx reaches it)                                                                             | 3030                                                                 | no                  |
| Web host port      | none (only the gctp cloudflared reaches it)                                                                    | 5173                                                                 | no                  |
| Postgres database  | `gctp`                                                                                                         | `gctp_dev`                                                           | no                  |
| Volumes            | `pgdata`, `valkey-data`, `osrm-data`, `gctp-uploads`                                                           | `pgdata-dev`, `valkey-data-dev` (uploads on host: `./data/uploads/`) | no                  |
| Public ingress     | dedicated Cloudflare Tunnel + Access ([ADR-0015](../adr/0015-isolated-network-dedicated-cloudflare-tunnel.md)) | n/a                                                                  | no                  |

Wiping dev state (`docker compose -p gctp-dev -f infra/docker-compose.dev.yml down -v`) can never touch UAT postgres or UAT valkey. OSRM is shared but stateless from the consumer's perspective — dev cache cells in `route_legs` are stamped `osrm_version='unknown'` (the dev api can't read UAT's `/osrm-meta/osrm-version.txt` from the host) and stay cleanly namespaced from UAT's version-stamped cells.

### When UAT's OSRM is offline

Dev iteration on UI, schema, uploads, and the admin surface doesn't depend on OSRM — the script probes the URL and warns but continues. Planner endpoints (`/tours/clusters`, `/tours/plan`) return 500 until OSRM is back. Re-start UAT's OSRM with `cd infra && docker compose up -d osrm`.

For the full container-shape stack (api + web also in compose), use the production-like recipe below — handy for validating Dockerfile changes or simulating a UAT-shape deploy.

## Environments & promotion

Three tiers, each with a clear owner and a clear source. A deployed stack is
isolated on its own Docker network behind a **dedicated Cloudflare Tunnel** with
**Cloudflare Access** in front ([ADR-0015](../adr/0015-isolated-network-dedicated-cloudflare-tunnel.md)); no host ports are published, and `web` (nginx) is the single same-origin edge that serves the SPA and reverse-proxies `/api/*` → `api:3000`.

| Tier     | Where                                          | Source                                              | Validated by                                      |
| -------- | ---------------------------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| **dev**  | `gctp-dev` compose project (shared host, shifted ports) | the working tree under `pnpm dev`           | the author/agent — fast inner loop                |
| **UAT**  | the `gctp` compose stack (shared host)         | the **feature branch under test** (checked out)     | the owner — acceptance **before** the PR          |
| **prod** | a **separate host**                            | **`main`** (only ever merged code)                  | the PR is the final gate; prod is the live result |

The path for any change:

1. **dev** — the author/agent iterates and self-validates (`pnpm dev`; unit / integration / e2e per [testing.md](testing.md)).
2. **UAT** — when it's ready for the owner to try, deploy the **feature branch** to UAT for acceptance. On the UAT host:
   - `git fetch && git checkout <branch> && git pull --ff-only`
   - `cd infra && docker compose up --build -d` — recreates the stack + the `cloudflared` connector (migrations run via the one-shot `migrate` service, below). A single service is enough for a web-only change: `docker compose up --build -d web`.
   - `docker compose logs -f api web cloudflared` for the first minute.
3. **PR** — open the PR into `main`; **CI is the final validation gate** (build / lint / typecheck / test / licenses / docs-links). Merge on green.
4. **prod** — prod tracks `main` on a separate host; promote **manually** after the merge. On the prod host:
   - `git checkout main && git pull --ff-only` — prod must sit exactly on `main`; if `--ff-only` refuses, the checkout drifted (don't force — investigate).
   - `cd infra && docker compose up --build -d`, then tail logs to confirm health + tunnel registration.

The public hostname route and the Access policy are dashboard state in Cloudflare Zero Trust, not in the repo; `CLOUDFLARE_TUNNEL_TOKEN` is the only related env knob.

> **This replaces the earlier "UAT tracks `main`" model.** UAT is now the owner's pre-PR acceptance tier and *does* run in-flight feature branches; **prod** is the always-`main` tier. Keep prod's checkout exactly on `main`; UAT's checkout floats with whatever branch is under test (reset it to `main` or the next branch as needed).

DB migrations apply automatically on every `docker compose up --build`: the one-shot `migrate` service ([Dockerfile.migrate](../../infra/Dockerfile.migrate)) runs `node-pg-migrate up` against the live Postgres and exits 0; `api`, `jobs`, and `osm2pgsql-import` all `depends_on: migrate: service_completed_successfully`, so they wait until the schema is at the latest revision. No host-side migrate command is needed. To re-run migrations explicitly (e.g. after editing a SQL file without bumping any image): `docker compose up -d --force-recreate migrate`.

OSRM preprocessing (first boot, ~10 min for a country extract) runs in the `osrm` service via `infra/osrm/bootstrap.sh`. Subsequent boots reuse `osrm-data`. Landuse polygons are populated by a parallel one-shot `osm2pgsql-import` service into the existing Postgres (see [ADR-0009](../adr/0009-osm2pgsql-replaces-overpass.md)).

## OSM data refresh

Both OSRM and landuse refresh from the same Geofabrik PBFs. Run the unified refresh script when you want fresh OSM data:

```bash
./scripts/refresh-osm-data.sh
```

It re-downloads the regional PBFs, re-preprocesses OSRM, and re-imports landuse — all against the same daily snapshot, so the two halves stay in lockstep ([ADR-0010](../adr/0010-unified-osm-refresh.md)). Wall clock: ~15 min for NL alone, ~30 min for NL + NRW. Existing `route_legs` rows tagged with the previous `osrm_version` are automatically ignored on read and repopulate via `walking-precompute` on the next upload (or lazily on the next plan). A weekly host systemd timer to run the script is a planned follow-up.

## What's deliberately not here yet

- **No CI auto-deploy.** Both UAT (feature branch) and prod (`main`) are promoted manually — `git checkout … && docker compose up --build -d` on the relevant host. Auto-deploy-on-merge for prod is a future option; the blast radius of a bad merge is why it's still a human step.
- No rollback button. Rollback = `git revert` on `main` + re-promote (or, on UAT, check out a known-good branch and rebuild).

## Production (prod tier)

Prod runs on a **separate host** from UAT and tracks `main`. Per [docs/architecture/background-and-deploy.md](../architecture/background-and-deploy.md), it differs from UAT:

- `NODE_ENV=production` (UAT uses `NODE_ENV=uat`). The auth config refuses `AUTH_DEV_BYPASS` under production.
- TLS is terminated at the Cloudflare edge (the tunnel origin is plain HTTP on the internal network); no on-box cert. Authentication is the app's own session/OAuth, with Cloudflare Access in front per [ADR-0015](../adr/0015-isolated-network-dedicated-cloudflare-tunnel.md) / its staged removal in [ADR-0023](../adr/0023-staged-cloudflare-access-tunnel-removal.md).
- Backups on `pgdata`, `osrm-data`, and `gctp-uploads` (not yet automated). Losing `gctp-uploads` is not catastrophic — the parsed cache data lives in Postgres — but it removes the ability to re-run `POST /admin/uploads/:id/reprocess` against historical uploads, so users would have to re-upload their PQs to back-fill any new parsed field.
- Per-host resource limits (CPU/mem) via `mem_limit` in compose for the API and web services.

## When something breaks in UAT or prod

1. `docker compose logs --tail 200 <service>` first.
2. Check `valkey-cli MONITOR` if BullMQ jobs look stuck.
3. `docker compose exec postgres psql ...` to read state directly.
4. If it's a planner regression: bisect with `git log -- apps/api/src/tours/`, redeploy the last-known-good commit.
