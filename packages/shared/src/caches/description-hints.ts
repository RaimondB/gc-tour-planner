// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * FR-SF8 — multilingual keyword scan over Groundspeak cache
 * descriptions. Attribute id 51 ("Special tool required") tells the
 * cacher *something* is needed but never *what*; the prose body
 * usually does. We run a small curated regex set during ingest and
 * persist the matched keys per cache so the popup can show
 * "🎣 fishing rod likely needed" without re-scanning at read time.
 *
 * Languages cover the typical PQ areas for the project's users
 * (English / Dutch / German) with room to extend. Keep this
 * dictionary small and high-precision — false positives in the
 * planner's visit-time bonus or "hide tool caches" filter are more
 * annoying than misses. When in doubt, leave the keyword out and
 * let the certain `TOOL_ATTRIBUTE_IDS` set carry it.
 */
export interface DescriptionHint {
  /** Stable key persisted on `caches.description_hints[]`. */
  key: string;
  /** Patterns matched against the stripped + lowercased description. */
  keywords: readonly RegExp[];
  /** Icon key resolved by the web's `<AttributeIcon>` component. */
  iconKey: string;
  /** Human-readable label for the popup chip. */
  label: string;
}

export const DESCRIPTION_HINTS: readonly DescriptionHint[] = [
  {
    key: "fishingRod",
    keywords: [
      /\b(fishing[\s-]*rod|fishing[\s-]*pole|angler)\b/i,
      // Dutch — "hengel" / "vishengel" / "visstok".
      /\b(hengel|vishengel|visstok)\b/i,
      // German — "Angel" alone is ambiguous ("angle") so require
      // "Angelrute" / "Angelhaken" or the unambiguous compound.
      /\b(angelrute|angelhaken|angelschnur)\b/i,
    ],
    iconKey: "fishing",
    label: "Fishing rod / angler pole",
  },
  {
    key: "binoculars",
    keywords: [
      /\b(binoculars?)\b/i,
      /\b(verrekijker)\b/i, // nl
      /\b(fernglas|ferngl[äa]ser)\b/i, // de
    ],
    iconKey: "binoculars",
    label: "Binoculars",
  },
  {
    key: "magnet",
    keywords: [
      /\b(magnet|magnetic)\b/i,
      /\b(magneet)\b/i, // nl
      // German "Magnet" matches the english regex above already.
    ],
    iconKey: "magnet",
    label: "Magnet",
  },
  {
    key: "tweezers",
    keywords: [
      /\b(tweezers)\b/i,
      /\b(pincet)\b/i, // nl
      /\b(pinzette)\b/i, // de
    ],
    iconKey: "tweezers",
    label: "Tweezers",
  },
  {
    key: "ladder",
    keywords: [
      /\b(ladder)\b/i,
      /\b(leiter)\b/i, // de
      // Dutch "ladder" matches the english regex.
    ],
    iconKey: "ladder",
    label: "Ladder",
  },
  {
    key: "mirror",
    keywords: [
      /\b(mirror)\b/i,
      /\b(spiegel)\b/i, // nl + de share the word
    ],
    iconKey: "mirror",
    label: "Mirror",
  },
];

const HINT_BY_KEY: ReadonlyMap<string, DescriptionHint> = new Map(
  DESCRIPTION_HINTS.map((h) => [h.key, h] as const),
);

/** Look up a hint's metadata by key. Returns `undefined` for unknown keys. */
export function descriptionHintByKey(key: string): DescriptionHint | undefined {
  return HINT_BY_KEY.get(key);
}

/**
 * Scan a cache's description text for tool-hint keywords. Returns a
 * deduplicated, stable-order array of matched hint keys. Empty array
 * when nothing matched.
 *
 * The caller (parser) is responsible for stripping HTML and feeding
 * a plain-text string. We don't strip here so this stays a pure
 * function over its input string — easier to unit-test.
 */
export function scanDescriptionHints(text: string): string[] {
  if (!text) return [];
  const matched: string[] = [];
  // Preserve dictionary order so reading the keys later gives a
  // stable, sensible visual order in the chip row.
  for (const hint of DESCRIPTION_HINTS) {
    for (const re of hint.keywords) {
      if (re.test(text)) {
        matched.push(hint.key);
        break; // one regex match per hint is enough
      }
    }
  }
  return matched;
}
