// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { XMLParser } from "fast-xml-parser";
import {
  CACHE_TYPES,
  type CacheType,
  type WaypointType,
} from "../caches/index.js";
import type { ParsedCache, ParsedGpx, ParsedWaypoint } from "./types.js";

/**
 * Parse a Groundspeak Pocket Query (or generic) GPX document into the project's
 * canonical shapes.
 *
 * Behavior:
 * - Each `<wpt>` with a `<groundspeak:cache>` child becomes a `ParsedCache`.
 * - Other `<wpt>` rows are heuristically classified as additional waypoints
 *   (parking, reference, stages, trailhead, final, question) using `<sym>` and
 *   the `<name>` prefix conventions used by GSAK and the Groundspeak app.
 * - The parser never throws on a recoverable problem; it records the issue in
 *   `warnings` and skips the offending row. Catastrophic XML errors do throw.
 */
export function parseGpx(xml: string): ParsedGpx {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: false,
    parseTagValue: true,
    parseAttributeValue: true,
    trimValues: true,
    isArray: (name) => name === "wpt" || name === "groundspeak:attribute",
  });

  const doc = parser.parse(xml) as {
    gpx?: { wpt?: GpxWpt[] };
  };
  const wpts = doc.gpx?.wpt ?? [];

  const caches: ParsedCache[] = [];
  const waypoints: ParsedWaypoint[] = [];
  const warnings: string[] = [];

  for (const wpt of wpts) {
    const lat = numOrNull(wpt["@_lat"]);
    const lon = numOrNull(wpt["@_lon"]);
    if (lat === null || lon === null) {
      warnings.push(
        `<wpt> missing lat/lon (name="${wpt.name ?? ""}") — skipped`,
      );
      continue;
    }

    const gsCache = wpt["groundspeak:cache"];
    const sym = textOrNull(wpt.sym);
    const name = textOrNull(wpt.name) ?? "";

    if (gsCache) {
      const cache = toParsedCache(name, lat, lon, gsCache, warnings);
      if (cache) caches.push(cache);
      continue;
    }

    const wpType = classifyWaypoint(sym, name);
    if (!wpType) {
      warnings.push(
        `<wpt name="${name}" sym="${sym ?? ""}"> not recognized — skipped`,
      );
      continue;
    }

    waypoints.push({
      parentCode: extractParentCode(name),
      type: wpType,
      name,
      location: [lon, lat],
      note: textOrNull(wpt.desc) ?? textOrNull(wpt.cmt),
    });
  }

  return { caches, waypoints, warnings };
}

/* --- internal helpers --------------------------------------------------- */

interface GpxWpt {
  "@_lat"?: string | number;
  "@_lon"?: string | number;
  name?: string;
  desc?: string;
  cmt?: string;
  sym?: string;
  type?: string;
  "groundspeak:cache"?: GroundspeakCache;
}

interface GroundspeakCache {
  "@_id"?: string | number;
  "@_archived"?: string | boolean;
  "@_available"?: string | boolean;
  "groundspeak:name"?: string;
  "groundspeak:type"?: string;
  "groundspeak:difficulty"?: string | number;
  "groundspeak:terrain"?: string | number;
  "groundspeak:container"?: string;
  "groundspeak:attributes"?: {
    "groundspeak:attribute"?: GroundspeakAttribute[];
  };
}

interface GroundspeakAttribute {
  "@_id"?: string | number;
  "@_inc"?: string | number;
  "#text"?: string;
}

/** Map a Groundspeak cache type string to our canonical enum, or null if unknown. */
function normalizeCacheType(raw: string | undefined): CacheType | null {
  if (!raw) return null;
  // PQs label types like "Traditional Cache", "Multi-cache", "Unknown Cache", "Earthcache".
  const head = raw.split("|")[0]?.trim() ?? raw.trim();
  const lower = head.toLowerCase();
  if (lower.startsWith("traditional")) return "Traditional";
  if (lower.startsWith("multi")) return "Multi";
  if (
    lower.startsWith("unknown") ||
    lower.startsWith("mystery") ||
    lower.startsWith("puzzle")
  )
    return "Mystery";
  if (lower.startsWith("letterbox")) return "Letterbox";
  if (lower.startsWith("earth")) return "EarthCache";
  if (
    lower.startsWith("event") ||
    lower.startsWith("mega-event") ||
    lower.startsWith("giga-event")
  )
    return "Event";
  if (lower.startsWith("virtual")) return "Virtual";
  if (lower.startsWith("webcam")) return "Webcam";
  if (lower.startsWith("wherigo")) return "Wherigo";
  if (lower.startsWith("cito")) return "CITO";
  for (const t of CACHE_TYPES) if (lower === t.toLowerCase()) return t;
  return "Other";
}

function toParsedCache(
  name: string,
  lat: number,
  lon: number,
  gs: GroundspeakCache,
  warnings: string[],
): ParsedCache | null {
  const code = name.trim();
  if (!code) {
    warnings.push("<wpt> with groundspeak:cache but no <name> — skipped");
    return null;
  }
  const type = normalizeCacheType(
    textOrNull(gs["groundspeak:type"]) ?? undefined,
  );
  if (!type) {
    warnings.push(
      `cache ${code} has unknown type "${gs["groundspeak:type"]}" — using 'Other'`,
    );
  }
  const archivedAttr = gs["@_archived"];
  const archived =
    typeof archivedAttr === "boolean"
      ? archivedAttr
      : String(archivedAttr ?? "").toLowerCase() === "true";

  const attributes = (
    gs["groundspeak:attributes"]?.["groundspeak:attribute"] ?? []
  )
    .map((a) => ({
      id: Number(a["@_id"] ?? 0),
      positive: String(a["@_inc"] ?? "1") !== "0",
    }))
    .filter((a) => Number.isInteger(a.id) && a.id > 0);

  return {
    sourceId: code,
    code,
    type: type ?? "Other",
    name: (textOrNull(gs["groundspeak:name"]) ?? code).trim(),
    location: [lon, lat],
    difficulty: numOrNull(gs["groundspeak:difficulty"]),
    terrain: numOrNull(gs["groundspeak:terrain"]),
    size: textOrNull(gs["groundspeak:container"]),
    archived,
    attributes,
  };
}

/**
 * Classify an additional waypoint by `<sym>` (preferred) or by `<name>` prefix
 * (the GSAK/Groundspeak convention: PK = parking, RP = reference point,
 * ST = stages, TH = trailhead, FN = final, QA = question to answer).
 */
function classifyWaypoint(
  sym: string | null,
  name: string,
): WaypointType | null {
  const s = (sym ?? "").toLowerCase();
  if (s.includes("parking")) return "parking";
  if (s.includes("trailhead")) return "trailhead";
  if (s.includes("reference")) return "reference";
  if (
    s.includes("stages") ||
    s.includes("stage of") ||
    s.includes("virtual stage") ||
    s.includes("physical stage")
  )
    return "stages";
  if (s.includes("final")) return "final";
  if (s.includes("question")) return "question";

  const upper = name.toUpperCase();
  if (upper.startsWith("PK")) return "parking";
  if (upper.startsWith("TH")) return "trailhead";
  if (upper.startsWith("RP")) return "reference";
  if (upper.startsWith("ST")) return "stages";
  if (upper.startsWith("FN")) return "final";
  if (upper.startsWith("QA")) return "question";
  return null;
}

/**
 * Extract the parent cache code from a waypoint name.
 *
 * Groundspeak PQ companion files (`*-wpts.gpx`) name waypoints as
 * `<2-char prefix><cache-code-without-GC>` — e.g. `PA278XH` for parking,
 * `FL278XH` for the final, `018ZQ1F` for the first numbered stage. The first
 * two chars encode the waypoint type or sequence; the remaining 4–7 chars are
 * the cache code suffix.
 *
 * GSAK-style names instead embed the full `GCxxxxx` substring, e.g. `PK GC12345`.
 *
 * Returns the original name as a last resort so the upsert can still match if
 * a cache happens to share that exact code.
 */
function extractParentCode(name: string): string {
  const upper = name.toUpperCase();
  const gcMatch = upper.match(/GC[A-Z0-9]{1,7}/);
  if (gcMatch) return gcMatch[0];
  const prefixMatch = upper.match(/^[A-Z0-9]{2}([A-Z0-9]{4,7})$/);
  if (prefixMatch) return `GC${prefixMatch[1]}`;
  return name;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function textOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // fast-xml-parser sometimes returns an object like { '#text': '...' } when attributes coexist with text.
  if (typeof v === "object" && "#text" in v) {
    const t = (v as { "#text": unknown })["#text"];
    return typeof t === "string" ? t : t == null ? null : String(t);
  }
  return null;
}
