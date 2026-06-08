// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { AuthConfig } from "./auth.config.js";
import { AUTH_CONFIG } from "./auth.config.js";

/** Cloudflare Turnstile server-side verification endpoint. */
const SITEVERIFY_ENDPOINT =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Bound the outbound call so a slow/hanging siteverify can't pin a request. */
const VERIFY_TIMEOUT_MS = 5_000;

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

/**
 * Cloudflare Turnstile (CAPTCHA) verification for self-service registration
 * (FR-P5, Gate 1.4 of ADR-0023). While Cloudflare Access guards the app this is
 * redundant, but once Access is removed `POST /auth/register` is internet-facing;
 * a human-verification challenge blunts automated mass-registration that the
 * per-IP/per-email rate limits alone don't stop (the per-email cap is trivially
 * defeated with `user+1@`, `user+2@`… aliases).
 *
 * **Disabled when `TURNSTILE_SECRET` is unset** — registration stays open for
 * dev / local / tests. When enabled, a register without a valid token is
 * refused, and we **fail closed**: if siteverify is unreachable, the
 * registration is rejected rather than waved through.
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfig) {
    if (!cfg.turnstileSecret && cfg.isProduction) {
      this.logger.warn(
        "TURNSTILE_SECRET is unset: registration captcha is DISABLED. " +
          "Set it before removing Cloudflare Access (ADR-0023 Gate 1.4).",
      );
    }
  }

  /** Whether captcha verification is active (i.e. a secret is configured). */
  get enabled(): boolean {
    return this.cfg.turnstileSecret !== null;
  }

  /**
   * Verify a Turnstile token for a registration attempt. No-op when disabled.
   * Throws 400 if the token is missing, 403 if it fails verification, and 503
   * if siteverify can't be reached (fail closed — never silently allow).
   */
  async verify(
    token: string | undefined,
    remoteIp: string | undefined,
  ): Promise<void> {
    const secret = this.cfg.turnstileSecret;
    if (!secret) return; // disabled — open registration (dev / local / tests)

    if (!token || typeof token !== "string") {
      throw new BadRequestException("Captcha response is required");
    }

    const body = new URLSearchParams({ secret, response: token });
    // remoteip is optional but lets Cloudflare cross-check the solving client.
    if (remoteIp && remoteIp !== "unknown") body.set("remoteip", remoteIp);

    let data: SiteverifyResponse;
    try {
      const res = await fetch(SITEVERIFY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
      data = (await res.json()) as SiteverifyResponse;
    } catch (err) {
      this.logger.error(
        `Turnstile siteverify unreachable: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        "Captcha verification is temporarily unavailable. Please retry.",
      );
    }

    if (!data.success) {
      this.logger.warn(
        `Turnstile verification failed: ${(data["error-codes"] ?? []).join(", ") || "no error codes"}`,
      );
      throw new ForbiddenException("Captcha verification failed");
    }
  }
}
