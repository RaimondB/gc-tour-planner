// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";

/**
 * Route guard requiring the authenticated principal to be an admin (FR-P12).
 *
 * Runs AFTER the global `JwtAuthGuard` (which authenticates the session and
 * populates `req.user`), so apply it with `@UseGuards(AdminGuard)` on the
 * `/admin/*` controllers and the destructive planner-maintenance routes. A
 * non-admin (or anyone the global guard let through that lacks the flag) gets
 * 403. Fails closed: a missing/false `isAdmin` is rejected.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.user?.isAdmin === true) return true;
    throw new ForbiddenException("Admin role required");
  }
}
