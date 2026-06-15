// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { ApiError } from "../../lib/api.js";

/**
 * Map a failed login to a user-facing message. The server returns a deliberately
 * generic 401 for any bad-credentials case (auth design §7) — we keep it generic
 * here too so we never reveal whether an email exists.
 */
export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Invalid email or password.";
    if (err.status === 429) {
      return "Too many attempts. Please wait a minute and try again.";
    }
  }
  return "Something went wrong. Please try again.";
}

/** Map a failed registration to a user-facing message. */
export function registerErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return "That email is already registered.";
    if (err.status === 429) {
      return "Too many attempts. Please wait a minute and try again.";
    }
  }
  return "Something went wrong. Please try again.";
}

/** Map a failed set/change-password to a user-facing message. */
export function setPasswordErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400) {
      return "Enter your current password to change it.";
    }
    if (err.status === 401) return "Your current password is incorrect.";
    if (err.status === 429) {
      return "Too many attempts. Please wait a minute and try again.";
    }
  }
  return "Something went wrong. Please try again.";
}
