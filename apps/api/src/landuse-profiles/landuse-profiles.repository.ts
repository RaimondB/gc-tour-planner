// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "@gctp/db";
import type { LanduseProfiles } from "@gctp/shared";
import type { Kysely } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

/**
 * Read-side repository for `landuse_profiles` (M5-β).
 *
 * `owner_id IS NULL` rows are system profiles seeded by the migration —
 * every user sees them. Per-user profiles (owner_id = :userId) layer on
 * top once we add a UI for creating them; this round ships the system
 * defaults only.
 */
@Injectable()
export class LanduseProfilesRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Profiles visible to a given user — system rows plus the user's own.
   * Sorted with system profiles first, then by name. Stable order so
   * the sidebar dropdown reads the same on every reload.
   */
  async list(ownerId: string): Promise<LanduseProfiles.LanduseProfile[]> {
    const rows = await this.db
      .selectFrom("landuse_profiles")
      .selectAll()
      .where((eb) =>
        eb.or([eb("owner_id", "is", null), eb("owner_id", "=", ownerId)]),
      )
      .orderBy("owner_id", "asc")
      .orderBy("name", "asc")
      .execute();
    return rows.map(rowToDto);
  }

  /**
   * Single-row lookup used by the planner when scoring a cluster — must
   * respect the owner filter (a user can't accidentally peek at someone
   * else's private profile). Returns null when the id is not visible to
   * the caller.
   */
  async findById(
    ownerId: string,
    id: string,
  ): Promise<LanduseProfiles.LanduseProfile | null> {
    const row = await this.db
      .selectFrom("landuse_profiles")
      .selectAll()
      .where("id", "=", id)
      .where((eb) =>
        eb.or([eb("owner_id", "is", null), eb("owner_id", "=", ownerId)]),
      )
      .executeTakeFirst();
    return row ? rowToDto(row) : null;
  }
}

function rowToDto(row: {
  id: string;
  owner_id: string | null;
  name: string;
  description: string | null;
  kinds: unknown;
  created_at: Date;
}): LanduseProfiles.LanduseProfile {
  // `kinds` is stored as JSONB; pg returns it as a JS value already.
  // Cast defensively so a malformed seed can't crash the response.
  const kinds = Array.isArray(row.kinds)
    ? (row.kinds.filter((k) => typeof k === "string") as string[])
    : [];
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    kinds: kinds as LanduseProfiles.LanduseProfile["kinds"],
    createdAt: row.created_at,
  };
}
