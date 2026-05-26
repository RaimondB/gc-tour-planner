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
2. Brings up dev infra (`postgres`, `valkey`, `osrm`) via [infra/docker-compose.dev.yml](../../infra/docker-compose.dev.yml) under compose project name **`gctp-dev`** with host ports shifted **+10000** from UAT defaults:
   - postgres `localhost:15432`
   - valkey `localhost:16379`
   - osrm `localhost:15000`
3. Refuses to start if `API_PORT_DEV=3000` (Grafana on the nuc-deploy stack owns 3000).
4. Waits for postgres health (~5 s).
5. Runs any pending migrations via `pnpm --filter @gctp/db migrate:up`.
6. Launches api on `localhost:3030` and web on `localhost:5173` in parallel with interleaved `[api]`/`[web]` logs.
7. `Ctrl-C` cleans up api+web. Infra stays up.

### Clean separation from UAT

The dev stack is **fully isolated** from any UAT compose stack on the same machine:

| Concern | UAT | Dev |
|---|---|---|
| Compose project | `gctp` | `gctp-dev` |
| Compose file | `infra/docker-compose.yml` | `infra/docker-compose.dev.yml` |
| Postgres host port | 5432 | 15432 |
| Valkey host port | 6379 | 16379 |
| OSRM host port | 5000 | 15000 |
| API host port | 3000 (internal) / behind Traefik | 3030 |
| Web host port | behind Traefik | 5173 |
| Postgres database | `gctp` | `gctp_dev` |
| Volumes | `pgdata`, `valkey-data`, `osrm-data` | `pgdata-dev`, `valkey-data-dev`, `osrm-data-dev` |
| Traefik labels | yes | no |

Wiping dev state (`docker compose -p gctp-dev -f infra/docker-compose.dev.yml down -v`) can never touch UAT data.

### OSRM first-boot caveat

OSRM first boot takes ~10 min while it preprocesses the chosen Geofabrik extract into the `osrm-data-dev` volume. The script starts it but doesn't block — uploads, filtering, and map markers all work immediately. The planner endpoints (`/tours/clusters`, `/tours/plan`) start working once OSRM logs `running`. Tail with `docker compose -p gctp-dev -f infra/docker-compose.dev.yml logs -f osrm`.

For the full container-shape stack (api + web also in compose), use the production-like recipe below — handy for validating Dockerfile changes or simulating a UAT-shape deploy.

## Current state (pre-M6)

A single UAT instance runs at https://gctp.brookman.live, served from a home NUC behind Traefik. The deployment is manual:

1. SSH to the NUC.
2. `git pull` the gc-tour-planner repo.
3. `cd infra && docker compose up --build -d` — Traefik picks up the new containers via labels (see [infra/docker-compose.yml](../../infra/docker-compose.yml)).
4. `docker compose logs -f api web` for the first minute to confirm the stack is healthy.

OSRM preprocessing (first boot, ~10 min for a country extract) runs in the `osrm` service via `infra/osrm/bootstrap.sh`. Subsequent boots reuse `osrm-data`.

## What's deliberately not here yet

- No CI auto-deploy. M6+ may add a deploy workflow once auth lands and the blast radius of a bad merge grows.
- No staging environment separate from UAT — UAT *is* the only non-dev tier today.
- No rollback button. Rollback = `git revert` + redeploy.

## Production differences (when we get there)

Per [docs/architecture/background-and-deploy.md](../architecture/background-and-deploy.md):

- `NODE_ENV=production` (currently UAT uses `NODE_ENV=uat` so the AuthModule pre-M6 dev-user middleware stays active).
- TLS via Traefik + Let's Encrypt (already the case for UAT).
- Backups on the `pgdata` and `osrm-data` volumes (not yet automated).
- Per-host resource limits (CPU/mem) on `mem_limit` in compose for the API and web services.

## When something breaks in UAT

1. `docker compose logs --tail 200 <service>` first.
2. Check `valkey-cli MONITOR` if BullMQ jobs look stuck.
3. `docker compose exec postgres psql ...` to read state directly.
4. If it's a planner regression: bisect with `git log -- apps/api/src/tours/`, redeploy the last-known-good commit.
