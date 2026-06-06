// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "./auth.config.js";
import type { DevUserService } from "./dev-user.service.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import type { SessionData, SessionService } from "./session.service.js";

interface FakeReq {
  method: string;
  cookies?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  user?: unknown;
}

function makeContext(req: FakeReq, isPublic: boolean): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
    // The guard only reads isPublic via the reflector mock below, but the
    // reflector needs the handler/class refs from these two methods.
    _isPublic: isPublic,
  } as unknown as ExecutionContext;
}

const SESSION: SessionData = {
  sub: "user-1",
  email: "u@e.com",
  displayName: "U",
  csrf: "csrf-token",
  iat: 0,
};

const baseConfig: AuthConfig = {
  isProduction: false,
  devBypass: false,
  sessionSecret: "x",
  sessionTtlSeconds: 100,
  cookieSecure: false,
  cookieDomain: undefined,
  postLoginRedirect: "/",
  google: null,
};

describe("JwtAuthGuard", () => {
  let sessions: {
    get: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  let devUser: { resolve: ReturnType<typeof vi.fn> };

  function makeGuard(cfg: AuthConfig, isPublicReturn: boolean): JwtAuthGuard {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(isPublicReturn),
    } as unknown as Reflector;
    return new JwtAuthGuard(
      reflector,
      sessions as unknown as SessionService,
      devUser as unknown as DevUserService,
      cfg,
    );
  }

  beforeEach(() => {
    sessions = { get: vi.fn(), destroy: vi.fn(), create: vi.fn() };
    devUser = { resolve: vi.fn() };
  });

  it("allows @Public() routes without a session", async () => {
    const guard = makeGuard(baseConfig, true);
    const ctx = makeContext({ method: "POST", headers: {} }, true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(sessions.get).not.toHaveBeenCalled();
  });

  it("dev bypass attributes the dev user and skips CSRF", async () => {
    devUser.resolve.mockResolvedValue({
      id: "dev",
      email: "dev@gctp.local",
      displayName: "Dev",
    });
    const guard = makeGuard({ ...baseConfig, devBypass: true }, false);
    const req: FakeReq = { method: "POST", headers: {} };
    const ctx = makeContext(req, false);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({ email: "dev@gctp.local" });
    expect(sessions.get).not.toHaveBeenCalled();
  });

  it("401s when no session cookie is present", async () => {
    const guard = makeGuard(baseConfig, false);
    const ctx = makeContext({ method: "GET", headers: {} }, false);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("401s when the session is missing/expired", async () => {
    sessions.get.mockResolvedValue(null);
    const guard = makeGuard(baseConfig, false);
    const ctx = makeContext(
      { method: "GET", cookies: { sid: "abc" }, headers: {} },
      false,
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("populates req.user from a valid session on a safe method", async () => {
    sessions.get.mockResolvedValue(SESSION);
    const guard = makeGuard(baseConfig, false);
    const req: FakeReq = {
      method: "GET",
      cookies: { sid: "abc" },
      headers: {},
    };
    await expect(guard.canActivate(makeContext(req, false))).resolves.toBe(
      true,
    );
    expect(req.user).toEqual({
      id: "user-1",
      email: "u@e.com",
      displayName: "U",
    });
  });

  it("enforces double-submit CSRF on mutating methods", async () => {
    sessions.get.mockResolvedValue(SESSION);
    const guard = makeGuard(baseConfig, false);

    // Missing header → forbidden.
    await expect(
      guard.canActivate(
        makeContext(
          {
            method: "POST",
            cookies: { sid: "abc", csrf: "csrf-token" },
            headers: {},
          },
          false,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Header present but doesn't match the cookie → forbidden.
    await expect(
      guard.canActivate(
        makeContext(
          {
            method: "POST",
            cookies: { sid: "abc", csrf: "csrf-token" },
            headers: { "x-csrf-token": "wrong" },
          },
          false,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Header matches both the session token and the cookie → allowed.
    await expect(
      guard.canActivate(
        makeContext(
          {
            method: "POST",
            cookies: { sid: "abc", csrf: "csrf-token" },
            headers: { "x-csrf-token": "csrf-token" },
          },
          false,
        ),
      ),
    ).resolves.toBe(true);
  });
});
