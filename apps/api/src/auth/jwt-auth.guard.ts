// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { AuthConfig } from "./auth.config.js";
import { AUTH_CONFIG } from "./auth.config.js";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "./cookies.js";
import { DevUserService } from "./dev-user.service.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { SessionService } from "./session.service.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Global authentication guard (ADR-0021). Everything is authenticated by
 * default; only routes marked `@Public()` are exempt — that set is the
 * normative public-endpoint inventory (FR-P11).
 *
 * Order of checks:
 *   1. `@Public()` → allow, no auth, no CSRF.
 *   2. `AUTH_DEV_BYPASS=1` (non-prod only) → attribute to the dev user, skip CSRF.
 *   3. Otherwise → require a valid Valkey session (sliding TTL), then enforce
 *      the double-submit CSRF token on state-changing methods.
 *
 * The name is kept as `JwtAuthGuard` for continuity with the planned seam, even
 * though the session is Valkey-backed rather than a bare JWT.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly devUser: DevUserService,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();

    if (this.cfg.devBypass) {
      req.user = await this.devUser.resolve();
      return true; // bypass also skips CSRF so dev tooling / e2e need no token
    }

    const sessionId = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ];
    if (!sessionId) throw new UnauthorizedException("Not authenticated");

    const session = await this.sessions.get(sessionId);
    if (!session) throw new UnauthorizedException("Session expired");

    req.user = {
      id: session.sub,
      email: session.email,
      displayName: session.displayName,
      // Coerce so a pre-FR-P12 session (no isAdmin field) fails closed as false.
      isAdmin: session.isAdmin === true,
    };

    this.assertCsrf(req, session.csrf);
    return true;
  }

  /**
   * Double-submit CSRF check (FR-P8) on state-changing methods. The client
   * echoes the non-httpOnly `csrf` cookie in the `X-CSRF-Token` header; we
   * require the header to match the token bound to the session. `SameSite=Lax`
   * is the primary cross-site defense; this is belt-and-suspenders.
   */
  private assertCsrf(req: Request, sessionCsrf: string): void {
    if (SAFE_METHODS.has(req.method)) return;

    const header = req.headers[CSRF_HEADER];
    const headerToken = Array.isArray(header) ? header[0] : header;
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[
      CSRF_COOKIE
    ];

    if (
      !headerToken ||
      headerToken !== sessionCsrf ||
      headerToken !== cookieToken
    ) {
      throw new ForbiddenException("Invalid or missing CSRF token");
    }
  }
}
