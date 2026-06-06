// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "ioredis";
import type { AuthConfig } from "./auth.config.js";
import { AUTH_CONFIG } from "./auth.config.js";
import { VALKEY } from "./valkey.tokens.js";

/** The value stored in Valkey under a session id. */
export interface SessionData {
  /** User id (the `sub`). */
  sub: string;
  email: string;
  displayName: string;
  /** Double-submit CSRF token, minted with the session. */
  csrf: string;
  /** Issued-at, epoch seconds. */
  iat: number;
}

const SESSION_PREFIX = "sess:";

/**
 * Valkey-backed server sessions (ADR-0021). A session is an opaque random id
 * (the cookie value); its claims live in Valkey under `sess:<id>` with a
 * sliding TTL. This makes logout/revocation instant (delete the key) and "log
 * out everywhere" trivial (delete all of a user's keys) — neither is possible
 * with a stateless JWT.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
  ) {}

  /** Opaque, URL-safe 256-bit token. */
  private newToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private key(sessionId: string): string {
    return SESSION_PREFIX + sessionId;
  }

  /**
   * Create a session for a user. Returns the session id (the cookie value) and
   * the CSRF token bound to it.
   */
  async create(user: {
    id: string;
    email: string;
    displayName: string;
  }): Promise<{ sessionId: string; csrf: string }> {
    const sessionId = this.newToken();
    const csrf = this.newToken();
    const data: SessionData = {
      sub: user.id,
      email: user.email,
      displayName: user.displayName,
      csrf,
      iat: Math.floor(Date.now() / 1000),
    };
    await this.valkey.set(
      this.key(sessionId),
      JSON.stringify(data),
      "EX",
      this.cfg.sessionTtlSeconds,
    );
    return { sessionId, csrf };
  }

  /**
   * Look up a session and slide its TTL on a hit (FR-P7 sliding expiry).
   * Returns null for a missing/expired/corrupt session.
   */
  async get(sessionId: string): Promise<SessionData | null> {
    const raw = await this.valkey.get(this.key(sessionId));
    if (!raw) return null;
    let data: SessionData;
    try {
      data = JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
    // Sliding window: every authenticated request extends the lifetime.
    await this.valkey.expire(this.key(sessionId), this.cfg.sessionTtlSeconds);
    return data;
  }

  /** Delete a session (logout / instant revocation, FR-P6). */
  async destroy(sessionId: string): Promise<void> {
    await this.valkey.del(this.key(sessionId));
  }
}
