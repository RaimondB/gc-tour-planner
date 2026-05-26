# Requirements — Filtering

Hard filters narrow the candidate set; soft preferences re-rank without exclusion. See [design/data-model.md](../design/data-model.md) for how these flow into SQL.

- **FR-F1.** Search caches by center + radius (m).
- **FR-F2.** **Hard filter** on cache type (Traditional, Multi, Mystery, Letterbox, EarthCache, …).
- **FR-F3.** **Hard filter** on Groundspeak attributes (AND-of-OR groups, e.g. `(dog-allowed OR not-stroller) AND wheelchair-accessible`).
- **FR-F4.** Allow promoting any attribute from hard filter to **soft preference** with a positive or negative weight.
- **FR-F5.** **Soft preference** on OSM landuse kinds — predefined system profiles (e.g. "Forest hike day", "Urban evening stroll") plus user-owned custom profiles with per-kind weights.
- **FR-F6.** **Soft preference** on terrain and difficulty target values (with tolerance + weight).
- **FR-F7.** Filter results render on the map with debounced re-query as the user changes filters.
- **FR-F8 (exclude my finds).** The user can toggle a "Exclude caches I have found" filter. When enabled, every cache the current user has logged as found is omitted from results _and_ from the tour-planning pool. Found caches that are still shown (toggle off) are visually dimmed so the user can tell at a glance.
