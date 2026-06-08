// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AdminGuard } from "./admin.guard.js";

function ctx(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe("AdminGuard", () => {
  const guard = new AdminGuard();

  it("allows an admin principal", () => {
    expect(guard.canActivate(ctx({ id: "u", isAdmin: true }))).toBe(true);
  });

  it("rejects a non-admin", () => {
    expect(() => guard.canActivate(ctx({ id: "u", isAdmin: false }))).toThrow(
      ForbiddenException,
    );
  });

  it("fails closed when there is no user", () => {
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });

  it("fails closed when isAdmin is absent", () => {
    expect(() => guard.canActivate(ctx({ id: "u" }))).toThrow(
      ForbiddenException,
    );
  });
});
