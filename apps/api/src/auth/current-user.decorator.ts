// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createParamDecorator,
  type ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthUser } from "./auth.types.js";

/**
 * Resolves the current user from the request. Until the JWT module lands in M6
 * the dev middleware injects a stub user; in production an auth guard will
 * populate `request.user`. Either way, controllers receive a real `AuthUser`
 * here or a 401 — never `undefined`.
 */
export const CurrentUser = createParamDecorator(
  (_data, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (!user)
      throw new UnauthorizedException("No authenticated user on request");
    return user;
  },
);
