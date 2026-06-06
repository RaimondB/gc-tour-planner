// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { randomBytes } from "node:crypto";
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthConfig } from "./auth.config.js";
import { AUTH_CONFIG } from "./auth.config.js";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/**
 * Google OAuth 2.0 authorization-code flow (ADR-0021 §5), implemented with
 * `jose` + native `fetch` — no `passport` and no `openid-client`. This is the
 * most minimal GPLv3-compatible surface: the `state` is a short-lived signed
 * JWT, and the returned `id_token` is verified against Google's JWKS. **No
 * Google access/refresh tokens are persisted** — we read the verified id_token
 * claims and discard the rest (the "no third-party creds in DB" hard rule).
 */
@Injectable()
export class GoogleOAuthService {
  private readonly jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));

  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfig) {}

  private get google(): NonNullable<AuthConfig["google"]> {
    if (!this.cfg.google) {
      throw new ServiceUnavailableException(
        "Google OAuth is not configured (set OAUTH_GOOGLE_* env vars).",
      );
    }
    return this.cfg.google;
  }

  private secret(): Uint8Array {
    return new TextEncoder().encode(this.cfg.sessionSecret);
  }

  /** Build the Google consent-screen URL with a signed `state` (CSRF for the round-trip). */
  async authorizationUrl(): Promise<string> {
    const google = this.google;
    const state = await new SignJWT({ nonce: randomBytes(16).toString("hex") })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(this.secret());

    const params = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: google.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      // prompt + access_type kept minimal — we never store refresh tokens.
      prompt: "select_account",
    });
    return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
  }

  /** Verify the returned `state` JWT (rejects tampered/expired round-trips). */
  async verifyState(state: string | undefined): Promise<void> {
    if (!state) throw new UnauthorizedException("Missing OAuth state");
    try {
      await jwtVerify(state, this.secret());
    } catch {
      throw new UnauthorizedException("Invalid OAuth state");
    }
  }

  /**
   * Exchange the authorization code for tokens and return the verified profile.
   * Only the id_token claims are read; access/refresh tokens are discarded.
   */
  async exchangeCode(code: string | undefined): Promise<GoogleProfile> {
    if (!code) throw new UnauthorizedException("Missing authorization code");
    const google = this.google;

    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: google.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      throw new UnauthorizedException("Google token exchange failed");
    }
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) {
      throw new UnauthorizedException("Google response missing id_token");
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(tokens.id_token, this.jwks, {
        issuer: GOOGLE_ISSUERS,
        audience: google.clientId,
      }));
    } catch {
      throw new UnauthorizedException("Could not verify Google id_token");
    }

    const sub = typeof payload.sub === "string" ? payload.sub : undefined;
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const emailVerified = payload.email_verified === true;
    const name = typeof payload.name === "string" ? payload.name : null;

    if (!sub || !email) {
      throw new UnauthorizedException("Google profile missing sub/email");
    }
    return { sub, email, emailVerified, name };
  }
}
