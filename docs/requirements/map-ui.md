# Requirements — Map UI

MapLibre + filter sidebar + attribution. See [design/frontend.md](../design/frontend.md) for layer naming and component layout.

- **FR-M1.** MapLibre GL JS map with cache markers (clustered at low zoom), landuse polygon overlay (toggle), planned tour polyline, parking marker.
- **FR-M2.** Collapsible filter sidebar; map and sidebar always reflect the same query state.
- **FR-M3.** Display OSM attribution ("© OpenStreetMap contributors") on every map view.
- **FR-M4.** Attribute icons must be free-license (Material Symbols / text chips) — **never** bundle Groundspeak's copyrighted icons.
- **FR-M5 (search radius visible on map).** Render the current search radius as a non-interactive circle overlay around the active search center. The overlay updates immediately as the user changes the center or the radius.
- **FR-M6 (set center by clicking the map).** A single left-click anywhere on the map sets the search center to that point. Sidebar inputs reflect the new value; the camera does **not** jump (the user already chose the location visually).
- **FR-M7 (geolocate flies the camera).** Activating **Use my location** updates the search center _and_ flies the camera there at a sensible zoom (≈ radius-fitting). Sidebar inputs reflect the new value.
- **FR-M8 (decimal-dot lng/lat inputs).** Longitude and latitude inputs always display and accept `.` as the decimal separator, regardless of browser locale. (Comma input is also accepted as a convenience and normalized on commit.)
- **FR-M9 (OSM parking overlay).** Render OSM `amenity=parking` features (ADR-0011) from `GET /parking-facilities`: polygons (fill + outline) for way/relation parkings, circles for node parkings, "P" / "P€" text labels at high zoom. Style is keyed on `(access, fee)` — green for free public, blue for paid public, grey for customers, orange for permit. Layer is **viewport-following** (refetches on `moveend`, debounced + grid-snapped) and shares its visibility threshold with the cache-owner parking pins via a single `PARKING_MIN_ZOOM` constant. Sidebar exposes access (`yes`, `customers`, `permit` opt-in) and fee (`free` / `paid` / `any`) filter chips that drive both the rendered layer and the `osm-parking` start mode.
- **FR-M10 (viewport-following overlays).** Landuse, OSM parking, and the walking-graph debug overlay all follow the current map viewport — they refetch the visible bbox on pan/zoom rather than rendering the whole search radius. The bbox is grid-snapped so small pans don't refetch, and each layer clears its rendered features when the user zooms below its `minZoom` so the canvas matches the (no-)fetch state.
- **FR-M11 (state persistence).** Search filters, planner settings, and the map viewport survive a hard refresh via `localStorage`. Storage keys are prefixed `gctp:` so the user can purge them if state gets corrupted.
