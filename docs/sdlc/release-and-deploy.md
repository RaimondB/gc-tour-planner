# Release + deploy

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
