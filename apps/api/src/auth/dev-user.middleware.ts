// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { Database } from "@gctp/db";
import type { Kysely } from "kysely";
import type { NextFunction, Request, Response } from "express";
import { KYSELY } from "../database/database.tokens.js";
import type { AuthUser } from "./auth.types.js";

const DEV_USER = {
  email: "dev@gctp.local",
  displayName: "Dev User",
} as const;

/**
 * Until JWT auth lands in M6, every request is attributed to a single
 * `dev@gctp.local` user. The middleware upserts the row on first use so
 * downstream foreign keys resolve and the per-owner isolation contract is
 * exercised exactly as it will be in production.
 *
 * The middleware MUST NOT be registered when NODE_ENV=production.
 */
@Injectable()
export class DevUserMiddleware implements NestMiddleware {
  private cached: AuthUser | null = null;

  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    req.user = await this.resolve();
    next();
  }

  private async resolve(): Promise<AuthUser> {
    if (this.cached) return this.cached;

    const existing = await this.db
      .selectFrom("users")
      .select(["id", "email", "display_name"])
      .where("email", "=", DEV_USER.email)
      .executeTakeFirst();

    if (existing) {
      this.cached = {
        id: existing.id,
        email: existing.email,
        displayName: existing.display_name,
      };
      return this.cached;
    }

    const inserted = await this.db
      .insertInto("users")
      .values({ email: DEV_USER.email, display_name: DEV_USER.displayName })
      .returning(["id", "email", "display_name"])
      .executeTakeFirstOrThrow();

    this.cached = {
      id: inserted.id,
      email: inserted.email,
      displayName: inserted.display_name,
    };
    return this.cached;
  }
}
