// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A small embedded deny-list of the most common / breached passwords (FR-P5,
 * NIST SP 800-63B §5.1.1.2 "compromised values"). This is intentionally a
 * curated subset, not a full breach corpus: a complete check against a service
 * like Have I Been Pwned needs network egress and is deferred past M6. The
 * entries here are normalised (lower-cased, trimmed) and matched case-insensitively
 * so that e.g. "Password123" is rejected just like "password123".
 *
 * Keep the list short and high-signal; it exists to stop the truly trivial
 * choices that the 10-char minimum alone would otherwise admit
 * (e.g. "password11", "1234567890").
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "passw0rd123",
  "12345678",
  "123456789",
  "1234567890",
  "0123456789",
  "qwertyuiop",
  "qwerty12345",
  "1q2w3e4r5t",
  "1qaz2wsx3edc",
  "letmein123",
  "iloveyou123",
  "welcome123",
  "admin12345",
  "administrator",
  "changeme123",
  "abcdefghij",
  "abc123456789",
  "monkey12345",
  "dragon12345",
  "football123",
  "baseball123",
  "sunshine123",
  "princess123",
  "superman123",
  "trustno1234",
  "whatever123",
  "qazwsxedcrfv",
  "asdfghjkl1",
  "11111111",
  "00000000",
  "aaaaaaaaaa",
  "geocaching",
  "geocaching1",
  "geocache123",
]);

/** True if `password` (case-insensitively, trimmed) is on the common deny-list. */
export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.trim().toLowerCase());
}
