# Routing — OSRM

Lives at `apps/api/src/routing/`.

- `getLeg(fromId, toId, profile='foot')` reads `route_legs`; on miss, calls `OSRM_URL/route/v1/foot/{from};{to}?overview=full&geometries=geojson` and persists.
- `getMatrix(ids[])` reads/writes `route_legs` pairwise; falls back to OSRM `/table/v1/foot/{coords}` for fresh full matrices when no rows are cached.
- Foot profile only at MVP. Other profiles deferred to post-MVP.
