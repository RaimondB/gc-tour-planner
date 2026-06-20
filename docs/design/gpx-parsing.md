# GPX parsing

Lives at `packages/shared/src/gpx/parse.ts`. Pure function, used identically from `apps/api` (upload) and potentially from `apps/web` (preview).

- Streams via `sax` / `htmlparser2` — never buffers > 1 MB.
- Recognized extensions: `groundspeak:cache`, `groundspeak:attributes`, `groundspeak:short_description`, `groundspeak:long_description`.
- Additional waypoints: any `<wpt>` whose name starts with `PK` / `RP` / `ST` etc. _or_ whose `<sym>` is one of {`Parking Area`, `Reference Point`, `Stages of a Multicache`, `Trailhead`, `Final Location`, `Question to Answer`}. Map symbol → internal `type`.
- Output: `{ caches: ParsedCache[]; waypoints: ParsedWaypoint[]; warnings: string[] }`. No DB side effects — the caller upserts.
- Cache-type normalization (`normalizeCacheType`): maps Groundspeak type strings to the canonical `CACHE_TYPES` enum. **Adventure Lab stages** (manually exported via [Lab2Gpx](https://lab2gpx.gcutils.de/), which labels them `<groundspeak:type>Lab Cache</…>`) normalize to the `"Adventure Lab"` type — both `Lab Cache` and `Adventure Lab` inputs map to it. This lets users download a Lab2Gpx GPX for an area and upload it through the normal `/gpx/upload` path; stages then appear on the map and in tour planning like any other cache. (Phase 1 of Adventure Lab support — automated cluster enrichment is a later phase.)
- Adventure Lab deep link (`extractAdventureId`): a stage `<wpt>`'s `<url>https://labs.geocaching.com/goto/<guid></url>` yields `ParsedCache.adventureId` (persisted to `caches.adventure_id`). Only the `/goto/` host pattern matches, so an ordinary cache's geocaching.com `<url>` stays `null`. The GUID is the adventure's **deep-link** id (the only one the `/goto/` endpoint resolves — not the AL API's adventure Id); all stages of one Adventure share it, so it both groups them and powers the popup's "Open in Adventure Lab" link (a stage has no per-stage geocaching.com page, and its `code` is a Lab2Gpx-synthetic id).

## Solved / corrected coordinates (FR-I13) — parser intentionally unchanged

A Groundspeak GPX carries no machine-readable marker distinguishing a Mystery's _corrected_ coordinates from its bogus posted coords — when you've solved a puzzle, geocaching.com simply substitutes the corrected coords into the primary `<wpt>` lat/lon. There is therefore **nothing for the parser to detect**: it reads the `<wpt>` coordinate into `ParsedCache.location` as always. Whether those coords are treated as _solved_ is decided entirely by the user-asserted `solvedCoordinates=true` upload flag, applied downstream in `gpx.repository.ts`'s upsert (it writes `caches.location` + `solved` instead of `published_location`). Keep it that way — don't add coordinate-source heuristics to the parser.
