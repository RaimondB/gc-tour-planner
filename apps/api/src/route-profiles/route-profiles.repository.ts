// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "@gctp/db";
import { RouteProfiles } from "@gctp/shared";
import { sql, type Kysely, type Selectable } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

type Row = Selectable<Database["route_profiles"]>;

/**
 * `route_profiles` (FR-T19, ADR-0039). Reads see system presets
 * (`owner_id IS NULL`) plus the caller's own rows; writes only ever touch the
 * caller's own rows, so a system or foreign id behaves as "not found".
 */
@Injectable()
export class RouteProfilesRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /** System presets first, then the caller's own, each by name. */
  async list(ownerId: string): Promise<RouteProfiles.RouteProfile[]> {
    const rows = await this.db
      .selectFrom("route_profiles")
      .selectAll()
      .where((eb) =>
        eb.or([eb("owner_id", "is", null), eb("owner_id", "=", ownerId)]),
      )
      .orderBy(sql`owner_id IS NOT NULL`)
      .orderBy(sql`lower(name)`)
      .execute();
    return rows.map(rowToDto);
  }

  async create(
    ownerId: string,
    input: RouteProfiles.SaveRouteProfileInput,
  ): Promise<RouteProfiles.RouteProfile> {
    const row = await this.db
      .insertInto("route_profiles")
      .values({
        owner_id: ownerId,
        name: input.name,
        description: input.description,
        settings: JSON.stringify(input.settings),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToDto(row);
  }

  /** Null when the id isn't one of the caller's own profiles. */
  async update(
    ownerId: string,
    id: string,
    input: RouteProfiles.SaveRouteProfileInput,
  ): Promise<RouteProfiles.RouteProfile | null> {
    const row = await this.db
      .updateTable("route_profiles")
      .set({
        name: input.name,
        description: input.description,
        settings: JSON.stringify(input.settings),
        updated_at: sql`now()`,
      })
      .where("id", "=", id)
      .where("owner_id", "=", ownerId)
      .returningAll()
      .executeTakeFirst();
    return row ? rowToDto(row) : null;
  }

  /** False when the id isn't one of the caller's own profiles. */
  async delete(ownerId: string, id: string): Promise<boolean> {
    const res = await this.db
      .deleteFrom("route_profiles")
      .where("id", "=", id)
      .where("owner_id", "=", ownerId)
      .executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }
}

function rowToDto(row: Row): RouteProfiles.RouteProfile {
  // Parsing fills defaults for fields added after the profile was stored.
  return RouteProfiles.RouteProfile.parse({
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    settings: row.settings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
