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
