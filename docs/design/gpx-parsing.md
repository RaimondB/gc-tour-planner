# GPX parsing

Lives at `packages/shared/src/gpx/parse.ts`. Pure function, used identically from `apps/api` (upload) and potentially from `apps/web` (preview).

- Streams via `sax` / `htmlparser2` — never buffers > 1 MB.
- Recognized extensions: `groundspeak:cache`, `groundspeak:attributes`, `groundspeak:short_description`, `groundspeak:long_description`.
- Additional waypoints: any `<wpt>` whose name starts with `PK` / `RP` / `ST` etc. _or_ whose `<sym>` is one of {`Parking Area`, `Reference Point`, `Stages of a Multicache`, `Trailhead`, `Final Location`, `Question to Answer`}. Map symbol → internal `type`.
- Output: `{ caches: ParsedCache[]; waypoints: ParsedWaypoint[]; warnings: string[] }`. No DB side effects — the caller upserts.
