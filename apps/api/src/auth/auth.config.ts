// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** DI token for the resolved, validated auth configuration. */
export const AUTH_CONFIG = Symbol.for("@gctp/api/auth/AUTH_CONFIG");

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AuthConfig {
  /** Whether the process runs under NODE_ENV=production. */
  isProduction: boolean;
  /**
   * Dev/e2e bypass: when true, every request is attributed to the seeded
   * `dev@gctp.local` user without a login round-trip. HARD-REFUSED in
   * production (the factory throws), mirroring the old DevUserMiddleware.
   */
  devBypass: boolean;
  /** HS256 secret for signing the OAuth `state` (and any future short tokens). */
  sessionSecret: string;
  /** Sliding session lifetime, seconds. Default 30 days. */
  sessionTtlSeconds: number;
  /** `Secure` flag on auth cookies. Defaults to isProduction; overridable. */
  cookieSecure: boolean;
  /** Optional cookie domain (e.g. ".example.com"); undefined = host-only. */
  cookieDomain: string | undefined;
  /** Where the OAuth callback sends the browser after a successful sign-in. */
  postLoginRedirect: string;
  /** null when Google OAuth is not configured (the routes then 503). */
  google: GoogleOAuthConfig | null;
  /**
   * Cloudflare Turnstile secret for verifying the register challenge (FR-P5,
   * Gate 1.4). null when unset → captcha is disabled and registration is open
   * (dev / local / tests). When set, `POST /auth/register` requires a valid
   * Turnstile token. The matching site key is a build-time frontend env
   * (`VITE_TURNSTILE_SITE_KEY`), not server config — it is public by design.
   */
  turnstileSecret: string | null;
}

function bool(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

/**
 * Resolve auth config from the environment, validating invariants up front so a
 * misconfigured deploy fails fast at boot rather than on the first login.
 */
export function loadAuthConfig(config: ConfigService): AuthConfig {
  const isProduction = config.get<string>("NODE_ENV") === "production";

  const devBypass = bool(config.get<string>("AUTH_DEV_BYPASS"));
  if (devBypass && isProduction) {
    throw new Error(
      "AUTH_DEV_BYPASS must not be enabled in production. It attributes every " +
        "request to the dev user with no authentication (FR-P10).",
    );
  }

  const sessionSecret = config.get<string>("AUTH_SESSION_SECRET") ?? "";
  if (!sessionSecret && isProduction) {
    throw new Error(
      "AUTH_SESSION_SECRET is required in production (signs the OAuth state).",
    );
  }

  const ttlRaw = config.get<string>("AUTH_SESSION_TTL_SECONDS");
  const sessionTtlSeconds = ttlRaw ? Number(ttlRaw) : 30 * 24 * 60 * 60;
  if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error("AUTH_SESSION_TTL_SECONDS must be a positive number.");
  }

  const cookieSecureRaw = config.get<string>("AUTH_COOKIE_SECURE");
  const cookieSecure =
    cookieSecureRaw === undefined ? isProduction : bool(cookieSecureRaw);

  const clientId = config.get<string>("OAUTH_GOOGLE_CLIENT_ID");
  const clientSecret = config.get<string>("OAUTH_GOOGLE_CLIENT_SECRET");
  const redirectUri = config.get<string>("OAUTH_GOOGLE_REDIRECT_URI");
  const google =
    clientId && clientSecret && redirectUri
      ? { clientId, clientSecret, redirectUri }
      : null;

  return {
    isProduction,
    devBypass,
    // Fall back to an ephemeral dev secret only outside production (guarded above).
    sessionSecret: sessionSecret || "dev-insecure-session-secret",
    sessionTtlSeconds,
    cookieSecure,
    cookieDomain: config.get<string>("AUTH_COOKIE_DOMAIN") || undefined,
    postLoginRedirect: config.get<string>("OAUTH_POST_LOGIN_REDIRECT") ?? "/",
    google,
    turnstileSecret: config.get<string>("TURNSTILE_SECRET")?.trim() || null,
  };
}

export const authConfigProvider: Provider = {
  provide: AUTH_CONFIG,
  useFactory: loadAuthConfig,
  inject: [ConfigService],
};
