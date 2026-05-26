# Background work + deployment

## Background work

Two BullMQ queues live behind Valkey:

- **`overpass-refresh`** — accepts a bbox + landuse kinds; the worker calls Overpass, upserts `osm_landuse`. Triggered by the `osm` service when its cache is stale.
- **`prefetch`** — opportunistic: warm OD legs around recently-viewed clusters. Cancellable; low priority.

Workers live in a dedicated `jobs` container (separate Node process) so a job storm doesn't degrade API latency.

## Deployment topology

Single `docker compose up` brings everything up locally and in production. Services:

| Service    | Image                                                           | Notes                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` | `postgis/postgis:16-3.4`                                        | Volumes: `pgdata`.                                                                                                                                                                                                                                                                       |
| `valkey`   | `valkey/valkey:8`                                               | Volumes: `valkey-data` (appendonly).                                                                                                                                                                                                                                                     |
| `osrm`     | `ghcr.io/project-osrm/osrm-backend` + `infra/osrm/bootstrap.sh` | On first start, downloads the OSM extract (region from env) and runs `osrm-extract` + `osrm-contract` (foot profile). Volumes: `osrm-data`. The GHCR image (Alpine 3.21) is actively maintained; the legacy `osrm/osrm-backend` on Docker Hub was abandoned in 2021 with Debian 9 (EOL). |
| `api`      | `infra/Dockerfile.api` (multi-stage)                            | Reads DB + Valkey + OSRM + Overpass URLs from env.                                                                                                                                                                                                                                       |
| `web`      | `infra/Dockerfile.web`                                          | Nginx serving the Vite build; in dev, Vite dev server with HMR (override compose file).                                                                                                                                                                                                  |
| `jobs`     | `infra/Dockerfile.jobs`                                         | BullMQ workers; shares image layer cache with `api`.                                                                                                                                                                                                                                     |

Production differs only in:

- `NODE_ENV=production`.
- TLS terminated upstream (reverse proxy / load balancer).
- Backups on `pgdata` and `osrm-data`.
