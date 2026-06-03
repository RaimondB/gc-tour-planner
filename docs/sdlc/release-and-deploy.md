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

| Concern | UAT | Dev | Shared? |
|---|---|---|---|
| Compose project | `gctp` | `gctp-dev` | no |
| Compose file | `infra/docker-compose.yml` | `infra/docker-compose.dev.yml` | no |
| Postgres host port | 5432 | 15432 | no |
| Valkey host port | 6379 | 16379 | no |
| OSRM | container, port 5000 | **same container** via host:5000 | **YES (read-only)** |
| API host port | none (only `web` nginx reaches it) | 3030 | no |
| Web host port | none (only the gctp cloudflared reaches it) | 5173 | no |
| Postgres database | `gctp` | `gctp_dev` | no |
| Volumes | `pgdata`, `valkey-data`, `osrm-data`, `gctp-uploads` | `pgdata-dev`, `valkey-data-dev` (uploads on host: `./data/uploads/`) | no |
| Public ingress | dedicated Cloudflare Tunnel + Access ([ADR-0015](../adr/0015-isolated-network-dedicated-cloudflare-tunnel.md)) | n/a | no |

Wiping dev state (`docker compose -p gctp-dev -f infra/docker-compose.dev.yml down -v`) can never touch UAT postgres or UAT valkey. OSRM is shared but stateless from the consumer's perspective — dev cache cells in `route_legs` are stamped `osrm_version='unknown'` (the dev api can't read UAT's `/osrm-meta/osrm-version.txt` from the host) and stay cleanly namespaced from UAT's version-stamped cells.

### When UAT's OSRM is offline

Dev iteration on UI, schema, uploads, and the admin surface doesn't depend on OSRM — the script probes the URL and warns but continues. Planner endpoints (`/tours/clusters`, `/tours/plan`) return 500 until OSRM is back. Re-start UAT's OSRM with `cd infra && docker compose up -d osrm`.

For the full container-shape stack (api + web also in compose), use the production-like recipe below — handy for validating Dockerfile changes or simulating a UAT-shape deploy.

## Current state (pre-M6)

A single UAT instance runs on a shared host. It is isolated on its own Docker network and exposed via a **dedicated Cloudflare Tunnel** with **Cloudflare Access** in front for authentication ([ADR-0015](../adr/0015-isolated-network-dedicated-cloudflare-tunnel.md)) — gctp shares no network with any other workload on that host, and no host ports are published. `web` (nginx) is the single same-origin edge: it serves the SPA and reverse-proxies `/api/*` → `api:3000`. The deployment is manual:

1. SSH to the host.
2. `git pull` the gc-tour-planner repo.
3. `cd infra && docker compose up --build -d` — recreates the stack and the `cloudflared` connector (see [infra/docker-compose.yml](../../infra/docker-compose.yml)). The public hostname route (`app.example.com → http://web:80`) and the Access policy are dashboard state in Cloudflare Zero Trust, not in the repo; `CLOUDFLARE_TUNNEL_TOKEN` is the only related env knob.
4. `docker compose logs -f api web cloudflared` for the first minute to confirm the stack is healthy and the tunnel registers its connections.

DB migrations apply automatically as part of step 3: the one-shot `migrate` service ([Dockerfile.migrate](../../infra/Dockerfile.migrate)) runs `node-pg-migrate up` against the live Postgres and exits 0; `api`, `jobs`, and `osm2pgsql-import` all `depends_on: migrate: service_completed_successfully`, so they wait until the schema is at the latest revision. No host-side migrate command is needed. To re-run migrations explicitly (e.g. after editing a SQL file without bumping any image): `docker compose up -d --force-recreate migrate`.

OSRM preprocessing (first boot, ~10 min for a country extract) runs in the `osrm` service via `infra/osrm/bootstrap.sh`. Subsequent boots reuse `osrm-data`. Landuse polygons are populated by a parallel one-shot `osm2pgsql-import` service into the existing Postgres (see [ADR-0009](../adr/0009-osm2pgsql-replaces-overpass.md)).

## OSM data refresh

Both OSRM and landuse refresh from the same Geofabrik PBFs. Run the unified refresh script when you want fresh OSM data:

```bash
./scripts/refresh-osm-data.sh
```

It re-downloads the regional PBFs, re-preprocesses OSRM, and re-imports landuse — all against the same daily snapshot, so the two halves stay in lockstep ([ADR-0010](../adr/0010-unified-osm-refresh.md)). Wall clock: ~15 min for NL alone, ~30 min for NL + NRW. Existing `route_legs` rows tagged with the previous `osrm_version` are automatically ignored on read and repopulate via `walking-precompute` on the next upload (or lazily on the next plan). A weekly host systemd timer to run the script is a planned follow-up.

## What's deliberately not here yet

- No CI auto-deploy. M6+ may add a deploy workflow once auth lands and the blast radius of a bad merge grows.
- No staging environment separate from UAT — UAT *is* the only non-dev tier today.
- No rollback button. Rollback = `git revert` + redeploy.

## Production differences (when we get there)

Per [docs/architecture/background-and-deploy.md](../architecture/background-and-deploy.md):

- `NODE_ENV=production` (currently UAT uses `NODE_ENV=uat` so the AuthModule pre-M6 dev-user middleware stays active).
- TLS is terminated at the Cloudflare edge (the tunnel origin is plain HTTP on the internal network); no on-box cert. Authentication is enforced by Cloudflare Access until the M6 JWT module replaces the dev-user middleware ([ADR-0015](../adr/0015-isolated-network-dedicated-cloudflare-tunnel.md)).
- Backups on `pgdata`, `osrm-data`, and `gctp-uploads` (not yet automated). Losing `gctp-uploads` is not catastrophic — the parsed cache data lives in Postgres — but it removes the ability to re-run `POST /admin/uploads/:id/reprocess` against historical uploads, so users would have to re-upload their PQs to back-fill any new parsed field.
- Per-host resource limits (CPU/mem) on `mem_limit` in compose for the API and web services.

## When something breaks in UAT

1. `docker compose logs --tail 200 <service>` first.
2. Check `valkey-cli MONITOR` if BullMQ jobs look stuck.
3. `docker compose exec postgres psql ...` to read state directly.
4. If it's a planner regression: bisect with `git log -- apps/api/src/tours/`, redeploy the last-known-good commit.
