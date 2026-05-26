# Release + deploy

## Local dev loop

```
pnpm install        # one-shot bootstrap
pnpm dev            # infra in compose + api+web local with hot reload
# Ctrl-C stops api+web; infra keeps running
pnpm dev:down       # stop infra (volumes preserved)
```

`pnpm dev` is a thin wrapper around [scripts/dev.sh](../../scripts/dev.sh) that:

1. Ensures `infra/.env` exists (copies from `.env.example` on first run).
2. Brings up `postgres`, `valkey`, `osrm` in compose (skips api/web/jobs/solver — we run those locally).
3. Waits for postgres health (~5 s).
4. Runs any pending migrations via `pnpm --filter @gctp/db migrate:up`.
5. Launches api on `localhost:3030` and web on `localhost:5173` in parallel with interleaved `[api]`/`[web]` logs.
6. `Ctrl-C` cleans up the api+web processes. Infra stays up.

OSRM first boot takes ~10 min while it preprocesses the chosen Geofabrik extract. The script starts it but doesn't block — uploads, filtering, and map markers all work immediately. The planner endpoints (`/tours/clusters`, `/tours/plan`) start working once OSRM logs "running". Tail with `docker compose -f infra/docker-compose.yml logs -f osrm`.

For the full container-shape stack (api + web also in compose), use the production-like recipe below — handy for validating Dockerfile changes or simulating a UAT-shape deploy.

## Current state (pre-M6)

A single UAT instance runs at https://app.example.com, served from a host behind shared reverse proxy. The deployment is manual:

1. SSH to the host.
2. `git pull` the gc-tour-planner repo.
3. `cd infra && docker compose up --build -d` — shared reverse proxy picks up the new containers via labels (see [infra/docker-compose.yml](../../infra/docker-compose.yml)).
4. `docker compose logs -f api web` for the first minute to confirm the stack is healthy.

OSRM preprocessing (first boot, ~10 min for a country extract) runs in the `osrm` service via `infra/osrm/bootstrap.sh`. Subsequent boots reuse `osrm-data`.

## What's deliberately not here yet

- No CI auto-deploy. M6+ may add a deploy workflow once auth lands and the blast radius of a bad merge grows.
- No staging environment separate from UAT — UAT *is* the only non-dev tier today.
- No rollback button. Rollback = `git revert` + redeploy.

## Production differences (when we get there)

Per [docs/architecture/background-and-deploy.md](../architecture/background-and-deploy.md):

- `NODE_ENV=production` (currently UAT uses `NODE_ENV=uat` so the AuthModule pre-M6 dev-user middleware stays active).
- TLS via shared reverse proxy + Let's Encrypt (already the case for UAT).
- Backups on the `pgdata` and `osrm-data` volumes (not yet automated).
- Per-host resource limits (CPU/mem) on `mem_limit` in compose for the API and web services.

## When something breaks in UAT

1. `docker compose logs --tail 200 <service>` first.
2. Check `valkey-cli MONITOR` if BullMQ jobs look stuck.
3. `docker compose exec postgres psql ...` to read state directly.
4. If it's a planner regression: bisect with `git log -- apps/api/src/tours/`, redeploy the last-known-good commit.
