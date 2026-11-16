// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { randomBytes } from "node:crypto";

/** RFC 4648 base32 alphabet, lowercased. No padding, no 0/1/8/9 ambiguity. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Encode a buffer as lowercase RFC 4648 base32 (no padding). Self-contained so
 * we add no dependency (GPLv3 compatibility). 10 input bytes → exactly 16 chars.
 */
function base32(bytes: Buffer): string {
  let value = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 0b11111];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0b11111];
  return out;
}

/**
 * Mint an opaque, non-sequential tour share slug: 16 lowercase base32 chars
 * (~80 bits from `crypto.randomBytes(10)`), carrying no owner or tour-id info
 * (ADR-0022 §1). Not brute-forceable — which is why `GET /shared/:slug` is not
 * rate-limited (ADR-0022 §6). Callers retry on the rare UNIQUE collision.
 */
export function mintShareSlug(): string {
  return base32(randomBytes(10));
}
