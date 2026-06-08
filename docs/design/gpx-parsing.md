# GPX parsing

Lives at `packages/shared/src/gpx/parse.ts`. Pure function, used identically from `apps/api` (upload) and potentially from `apps/web` (preview).

- Streams via `sax` / `htmlparser2` — never buffers > 1 MB.
- Recognized extensions: `groundspeak:cache`, `groundspeak:attributes`, `groundspeak:short_description`, `groundspeak:long_description`.
- Additional waypoints: any `<wpt>` whose name starts with `PK` / `RP` / `ST` etc. _or_ whose `<sym>` is one of {`Parking Area`, `Reference Point`, `Stages of a Multicache`, `Trailhead`, `Final Location`, `Question to Answer`}. Map symbol → internal `type`.
- Output: `{ caches: ParsedCache[]; waypoints: ParsedWaypoint[]; warnings: string[] }`. No DB side effects — the caller upserts.

## Solved / corrected coordinates (FR-I13) — parser intentionally unchanged

A Groundspeak GPX carries no machine-readable marker distinguishing a Mystery's _corrected_ coordinates from its bogus posted coords — when you've solved a puzzle, geocaching.com simply substitutes the corrected coords into the primary `<wpt>` lat/lon. There is therefore **nothing for the parser to detect**: it reads the `<wpt>` coordinate into `ParsedCache.location` as always. Whether those coords are treated as _solved_ is decided entirely by the user-asserted `solvedCoordinates=true` upload flag, applied downstream in `gpx.repository.ts`'s upsert (it writes `caches.location` + `solved` instead of `published_location`). Keep it that way — don't add coordinate-source heuristics to the parser.
