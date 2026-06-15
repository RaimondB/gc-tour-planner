// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Redis } from "ioredis";
import { VALKEY } from "./valkey.tokens.js";

/** Per-email login/registration attempt cap within a sliding window (FR-P9). */
const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

/**
 * Per-email rate limiting on `/auth/login` and `/auth/register`, complementing
 * the per-IP `@Throttle` on the controller. Valkey-backed so the limit holds
 * across API replicas (a single IP cap is bypassable behind NAT / proxies, and
 * a per-email cap blunts credential-stuffing against one account). Errors are
 * generic — they never reveal whether the email exists (no user enumeration).
 */
@Injectable()
export class LoginLimiterService {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  private key(scope: string, email: string): string {
    return `authlimit:${scope}:${email.trim().toLowerCase()}`;
  }

  /** Increment the counter and throw 429 once the window cap is exceeded. */
  async hit(
    scope: "login" | "register" | "password",
    email: string,
  ): Promise<void> {
    const key = this.key(scope, email);
    const count = await this.valkey.incr(key);
    if (count === 1) {
      await this.valkey.expire(key, WINDOW_SECONDS);
    }
    if (count > MAX_ATTEMPTS) {
      throw new HttpException(
        "Too many attempts. Please try again later.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Clear the counter on a successful login (don't penalise legitimate users). */
  async reset(
    scope: "login" | "register" | "password",
    email: string,
  ): Promise<void> {
    await this.valkey.del(this.key(scope, email));
  }
}
