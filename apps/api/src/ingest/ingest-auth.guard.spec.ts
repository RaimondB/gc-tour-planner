// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { IngestConfig } from "./ingest.config.js";
import { IngestAuthGuard } from "./ingest-auth.guard.js";
import type {
  IngestActor,
  IngestTokenResolver,
} from "./ingest-token-resolver.js";

const enabled: IngestConfig = {
  enabled: true,
  apiKey: "k",
  ownerId: "owner-1",
};

/** Resolver that accepts exactly the token "good". */
const resolver: IngestTokenResolver = {
  resolve: async (t) => (t === "good" ? { ownerId: "owner-1" } : null),
};

interface FakeReq {
  headers: { authorization?: string };
  ingestActor?: IngestActor;
}

function ctx(req: FakeReq): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("IngestAuthGuard", () => {
  it("403s when the feature is disabled", async () => {
    const guard = new IngestAuthGuard(
      { enabled: false, apiKey: null, ownerId: null },
      resolver,
    );
    const req: FakeReq = { headers: { authorization: "Bearer good" } };
    await expect(guard.canActivate(ctx(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("401s when the Authorization header is missing", async () => {
    const guard = new IngestAuthGuard(enabled, resolver);
    await expect(
      guard.canActivate(ctx({ headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("401s when the scheme is not Bearer", async () => {
    const guard = new IngestAuthGuard(enabled, resolver);
    await expect(
      guard.canActivate(ctx({ headers: { authorization: "Basic good" } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("401s on an invalid token", async () => {
    const guard = new IngestAuthGuard(enabled, resolver);
    await expect(
      guard.canActivate(ctx({ headers: { authorization: "Bearer nope" } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("attaches the actor and allows on a valid token (case-insensitive scheme)", async () => {
    const guard = new IngestAuthGuard(enabled, resolver);
    const req: FakeReq = { headers: { authorization: "bearer good" } };
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
    expect(req.ingestActor).toEqual({ ownerId: "owner-1" });
  });
});
