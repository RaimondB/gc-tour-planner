# Frontend implementation notes

- **TanStack Query keys** mirror endpoint shape: `['caches', { center, radiusM, types, attributes, contexts }]`.
- **URL state**: filter form synced to `URLSearchParams` so reload + share preserve the view. Map center/zoom too.
- **Map layers** (MapLibre source/layer ids):
  - `caches-src` / `caches-layer` — clustered marker symbol.
  - `landuse-src` / `landuse-layer` — semi-transparent polygons, kind-colored.
  - `tour-src` / `tour-layer` — line layer, width-by-zoom.
  - `parking-src` / `parking-layer` — single marker with custom icon (Material Symbols, never Groundspeak).
- **Score breakdown panel** is always visible after planning. Each row: constraint name, weight, contribution, sign.
