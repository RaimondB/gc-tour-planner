// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "@gctp/db";
import type { Kysely } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string | null;
  isAdmin: boolean;
  /** Public GC account GUID for Lab2Gpx completion (FR-I19); null when unset. */
  gcUserGuid: string | null;
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * Data access for the `users` table. The table already exists from the init
 * migration; M6-α is the first code to write `password_hash`. `email` is
 * `CITEXT UNIQUE`, so lookups and the duplicate check are case-insensitive.
 */
@Injectable()
export class UsersRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async findByEmail(email: string): Promise<UserRow | undefined> {
    const row = await this.db
      .selectFrom("users")
      .select([
        "id",
        "email",
        "display_name",
        "password_hash",
        "is_admin",
        "gc_user_guid",
      ])
      .where("email", "=", email)
      .executeTakeFirst();
    return row ? this.toRow(row) : undefined;
  }

  async findById(id: string): Promise<UserRow | undefined> {
    const row = await this.db
      .selectFrom("users")
      .select([
        "id",
        "email",
        "display_name",
        "password_hash",
        "is_admin",
        "gc_user_guid",
      ])
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? this.toRow(row) : undefined;
  }

  /**
   * Insert a user. Returns null on a duplicate-email race (caller maps to 409)
   * rather than leaking the raw DB error.
   */
  async create(input: {
    email: string;
    displayName: string;
    passwordHash: string | null;
  }): Promise<UserRow | null> {
    try {
      const row = await this.db
        .insertInto("users")
        .values({
          email: input.email,
          display_name: input.displayName,
          password_hash: input.passwordHash,
        })
        .returning([
          "id",
          "email",
          "display_name",
          "password_hash",
          "is_admin",
          "gc_user_guid",
        ])
        .executeTakeFirstOrThrow();
      return this.toRow(row);
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  /**
   * Set (or replace) a user's password hash. Used by the authenticated
   * set/change-password flow — including letting an OAuth-only account
   * (`password_hash IS NULL`) gain its first password.
   */
  async setPasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db
      .updateTable("users")
      .set({ password_hash: passwordHash })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Set (or clear) the user's public Geocaching account GUID (FR-I19). Pass
   * `null` to clear it. Stored verbatim — it's a public identifier, not a secret.
   */
  async setGcUserGuid(id: string, gcUserGuid: string | null): Promise<void> {
    await this.db
      .updateTable("users")
      .set({ gc_user_guid: gcUserGuid })
      .where("id", "=", id)
      .execute();
  }

  private toRow(row: {
    id: string;
    email: string;
    display_name: string;
    password_hash: string | null;
    is_admin: boolean;
    gc_user_guid: string | null;
  }): UserRow {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      isAdmin: row.is_admin,
      gcUserGuid: row.gc_user_guid,
    };
  }
}
