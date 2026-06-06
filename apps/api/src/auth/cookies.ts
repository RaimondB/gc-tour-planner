// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { CookieOptions, Response } from "express";
import type { AuthConfig } from "./auth.config.js";

/** httpOnly session-id cookie. */
export const SESSION_COOKIE = "sid";
/** Non-httpOnly CSRF token cookie (double-submit; read by the web client). */
export const CSRF_COOKIE = "csrf";
/** Header the client echoes the CSRF cookie value in (design §4). */
export const CSRF_HEADER = "x-csrf-token";

function baseOptions(cfg: AuthConfig): CookieOptions {
  return {
    sameSite: "lax",
    secure: cfg.cookieSecure,
    domain: cfg.cookieDomain,
    path: "/",
  };
}

/** Set the httpOnly session cookie carrying the opaque session id. */
export function setSessionCookie(
  res: Response,
  cfg: AuthConfig,
  sessionId: string,
): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    ...baseOptions(cfg),
    httpOnly: true,
    maxAge: cfg.sessionTtlSeconds * 1000,
  });
}

/**
 * Set the non-httpOnly CSRF cookie. Readable by JS so the SPA can echo it in the
 * `X-CSRF-Token` header; its security comes from the double-submit comparison,
 * not from secrecy (`SameSite=Lax` is the primary cross-site defense).
 */
export function setCsrfCookie(
  res: Response,
  cfg: AuthConfig,
  token: string,
): void {
  res.cookie(CSRF_COOKIE, token, {
    ...baseOptions(cfg),
    httpOnly: false,
    maxAge: cfg.sessionTtlSeconds * 1000,
  });
}

/** Clear both auth cookies (logout). Options must match how they were set. */
export function clearAuthCookies(res: Response, cfg: AuthConfig): void {
  const opts = baseOptions(cfg);
  res.clearCookie(SESSION_COOKIE, { ...opts, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...opts, httpOnly: false });
}
