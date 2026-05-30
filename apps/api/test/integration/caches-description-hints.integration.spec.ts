// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Smoke test for migration 1779670000000_caches_description_hints:
// verifies the new `caches.description_hints` column exists as a nullable
// text[] and round-trips the three documented states (NULL, empty array,
// non-empty array). Real PostGIS via Testcontainers — no DB mocks
// (CLAUDE.md hard rule).

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

describe("caches.description_hints (migration 1779670000000)", () => {
  let pg: PostgresFixture;
  let ownerId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    const user = await pg.db
      .insertInto("users")
      .values({ email: "pr3-hints@gctp.local", display_name: "PR3Hints" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("information_schema reports description_hints as nullable ARRAY of text", async () => {
    const cols = await sql<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>`
      SELECT column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'caches'
        AND column_name = 'description_hints'
    `.execute(pg.db);

    expect(cols.rows).toEqual([
      {
        column_name: "description_hints",
        // information_schema reports array columns as 'ARRAY' with the
        // element type in udt_name (prefixed by underscore).
        data_type: "ARRAY",
        udt_name: "_text",
        is_nullable: "YES",
        column_default: null,
      },
    ]);
  });

  it("does not register an index on description_hints (filtering is client-side)", async () => {
    const idxs = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'caches'
        AND indexdef ILIKE '%description_hints%'
    `.execute(pg.db);

    expect(idxs.rows).toEqual([]);
  });

  it("round-trips the three documented nullability states", async () => {
    // (a) NULL = never scanned.
    const nullRow = await pg.db
      .insertInto("caches")
      .values({
        owner_id: ownerId,
        source: "gpx",
        source_id: "GC-HINT-NULL",
        code: "GCHINTN",
        type: "Traditional Cache",
        name: "never-scanned",
        location: sql`ST_SetSRID(ST_MakePoint(4.9, 52.3), 4326)::geography`,
        raw: sql`'{}'::jsonb`,
        // description_hints omitted -> column defaults to NULL.
      })
      .returning(["id", "description_hints"])
      .executeTakeFirstOrThrow();
    expect(nullRow.description_hints).toBeNull();

    // (b) Empty array = scanned, nothing matched.
    const emptyRow = await pg.db
      .insertInto("caches")
      .values({
        owner_id: ownerId,
        source: "gpx",
        source_id: "GC-HINT-EMPTY",
        code: "GCHINTE",
        type: "Traditional Cache",
        name: "scanned-empty",
        location: sql`ST_SetSRID(ST_MakePoint(4.91, 52.31), 4326)::geography`,
        raw: sql`'{}'::jsonb`,
        description_hints: [],
      })
      .returning(["id", "description_hints"])
      .executeTakeFirstOrThrow();
    expect(emptyRow.description_hints).toEqual([]);

    // (c) Non-empty array round-trips intact, preserving order + duplicates.
    const hints = ["fishingRod", "binoculars", "magnet"];
    const fullRow = await pg.db
      .insertInto("caches")
      .values({
        owner_id: ownerId,
        source: "gpx",
        source_id: "GC-HINT-FULL",
        code: "GCHINTF",
        type: "Traditional Cache",
        name: "scanned-hits",
        location: sql`ST_SetSRID(ST_MakePoint(4.92, 52.32), 4326)::geography`,
        raw: sql`'{}'::jsonb`,
        description_hints: hints,
      })
      .returning(["id", "description_hints"])
      .executeTakeFirstOrThrow();
    expect(fullRow.description_hints).toEqual(hints);
  });
});
