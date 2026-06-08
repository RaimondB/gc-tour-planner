// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "@gctp/db";
import type { Kysely } from "kysely";
import { KYSELY } from "../database/database.tokens.js";
import type { AuthUser } from "./auth.types.js";

const DEV_USER = {
  email: "dev@gctp.local",
  displayName: "Dev User",
} as const;

/**
 * Resolves the seeded `dev@gctp.local` user for the `AUTH_DEV_BYPASS=1` path
 * used by local dev and Playwright e2e (FR-P10). Upserts the row on first use so
 * downstream foreign keys resolve and per-owner isolation is exercised exactly
 * as in production. Replaces the old DevUserMiddleware; the bypass is gated by
 * config and hard-refused under NODE_ENV=production (see auth.config.ts).
 */
@Injectable()
export class DevUserService {
  private cached: AuthUser | null = null;

  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async resolve(): Promise<AuthUser> {
    if (this.cached) return this.cached;

    const existing = await this.db
      .selectFrom("users")
      .select(["id", "email", "display_name"])
      .where("email", "=", DEV_USER.email)
      .executeTakeFirst();

    const row =
      existing ??
      (await this.db
        .insertInto("users")
        .values({ email: DEV_USER.email, display_name: DEV_USER.displayName })
        .returning(["id", "email", "display_name"])
        .executeTakeFirstOrThrow());

    this.cached = {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      // The dev-bypass principal is treated as an admin so local dev / e2e can
      // exercise /admin/* exactly as before. The bypass is hard-refused under
      // NODE_ENV=production (auth.config.ts), so this never grants prod access.
      isAdmin: true,
    };
    return this.cached;
  }
}
