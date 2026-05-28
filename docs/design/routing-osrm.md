# Routing — OSRM

Lives at `apps/api/src/routing/`.

- `getLeg(fromId, toId, profile='foot')` reads `route_legs`; on miss, calls `OSRM_URL/route/v1/foot/{from};{to}?overview=full&geometries=geojson` and persists.
- `getMatrix(ids[])` reads/writes `route_legs` pairwise; falls back to OSRM `/table/v1/foot/{coords}` for fresh full matrices when no rows are cached.
- Foot profile only at MVP. Other profiles deferred to post-MVP.

## Concurrency control

- **API → OSRM (inbound).** `HttpOsrmClient` ([apps/api/src/routing/osrm.client.ts](../../apps/api/src/routing/osrm.client.ts)) wraps every public method (`route`, `routeAlternatives`, `routeMulti`, `table`, `nearest`) in a global FIFO semaphore. At most `OSRM_MAX_CONCURRENCY` requests (default 8) are in flight; surplus queues. Singleton provider, so the counter is process-global, not per-controller. Stops bursty multi-user planner clicks from overwhelming the single-process `osrm-routed`.
- **OSRM internal parallelism.** `osrm-routed --threads N` is set from `OSRM_THREADS` (default 4) in [infra/osrm/bootstrap.sh](../../infra/osrm/bootstrap.sh). host is 4C/8T; default keeps headroom for postgres + api. Raise for higher single-tenant throughput; lower if OSRM starves the rest of the stack.
- The two layers compose: under load, at most 8 requests in flight, served by 4 worker threads; extra requests queue inside OSRM rather than starve the API event loop.

## Bundled calls

- `tours.service.ts::getParkingOptions` issues ONE `/table` covering all parking candidates × all cluster caches, picks each parking's walking-nearest cache, then issues `/route` only for the survivors after fee/access/maxOptions filtering. Previously N parking candidates → N `routeAlternatives` calls.
- Pass-2 parking-trim issues ONE `/table` of `[parking, ...caches]` to compute parking-to-cache distances for `marginal-trim`'s endpoint eligibility check.
