// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { isCommonPassword } from "./common-passwords.js";

export * from "./common-passwords.js";

/**
 * NIST SP 800-63B-aligned password policy (FR-P5):
 *   - minimum 10 characters,
 *   - accept long passphrases (up to 128 chars),
 *   - NO composition rules (no forced upper/lower/digit/symbol mix),
 *   - reject common / breached values (see common-passwords.ts).
 *
 * The 128-char ceiling is a denial-of-service guard for argon2 (hashing an
 * unbounded string is expensive), not a complexity rule — the spec asks us to
 * "accept ≥ 128", which we honour by allowing exactly up to 128.
 */
export const Password = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters")
  .refine((p) => !isCommonPassword(p), {
    message: "Password is too common — choose a less predictable one",
  });

/** Display name: required, trimmed, 1–80 chars. */
export const DisplayName = z
  .string()
  .trim()
  .min(1, "Display name is required")
  .max(80, "Display name must be at most 80 characters");

export const RegisterInput = z.object({
  email: z.email().max(254),
  password: Password,
  displayName: DisplayName,
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email: z.email().max(254),
  // Login validates against the stored hash, not the policy — accept any
  // non-empty string so a tightened policy never locks out existing users.
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof LoginInput>;

/**
 * The authenticated principal as exposed on the wire (`GET /auth/me`) and as
 * resolved by the API's `@CurrentUser()` decorator. Structurally identical to
 * the API-side `AuthUser` interface — kept here as the single shared contract.
 */
export const AuthUser = z.object({
  id: z.guid(),
  email: z.string(),
  displayName: z.string(),
});
export type AuthUser = z.infer<typeof AuthUser>;
