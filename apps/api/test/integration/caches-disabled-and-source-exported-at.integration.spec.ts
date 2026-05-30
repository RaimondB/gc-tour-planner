// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Smoke test for migration 1779660000000_caches_disabled_and_source_exported_at:
// verifies the new `caches.disabled` / `caches.source_exported_at` /
// `gpx_uploads.exported_at` columns exist with the right shape, that the
// partial composite index `caches_owner_active_idx` is registered with the
// expected predicate, and that the listCaches hot-path WHERE clause works
// end-to-end. Real PostGIS via Testcontainers — no DB mocks (CLAUDE.md hard
// rule).

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

describe("caches disabled + source_exported_at (migration 1779660000000)", () => {
  let pg: PostgresFixture;
  let ownerId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    const user = await pg.db
      .insertInto("users")
      .values({ email: "pr2-cols@gctp.local", display_name: "PR2Cols" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("information_schema reports the three new columns with the right shape", async () => {
    const cacheCols = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'caches'
        AND column_name IN ('disabled', 'source_exported_at')
      ORDER BY column_name
    `.execute(pg.db);

    expect(cacheCols.rows).toEqual([
      {
        column_name: "disabled",
        data_type: "boolean",
        is_nullable: "NO",
        column_default: "false",
      },
      {
        column_name: "source_exported_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        column_default: null,
      },
    ]);

    const uploadCols = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'gpx_uploads'
        AND column_name = 'exported_at'
    `.execute(pg.db);

    expect(uploadCols.rows).toEqual([
      {
        column_name: "exported_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      },
    ]);
  });

  it("registers caches_owner_active_idx as a partial index with the listCaches predicate", async () => {
    const idx = await sql<{
      indexname: string;
      indexdef: string;
    }>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'caches_owner_active_idx'
    `.execute(pg.db);

    expect(idx.rows).toHaveLength(1);
    const def = idx.rows[0]!.indexdef;
    // Confirm shape: btree on owner_id, partial on NOT archived AND NOT disabled.
    expect(def).toMatch(/USING btree \(owner_id\)/);
    expect(def).toMatch(/WHERE \(\(?NOT archived\)? AND \(?NOT disabled\)?\)?/);
  });

  it("defaults disabled=false and source_exported_at=NULL on insert, and round-trips both", async () => {
    const defaults = await pg.db
      .insertInto("caches")
      .values({
        owner_id: ownerId,
        source: "gpx",
        source_id: "GC-DEF-1",
        code: "GCDEF1",
        type: "Traditional Cache",
        name: "defaults",
        location: sql`ST_SetSRID(ST_MakePoint(4.9, 52.3), 4326)::geography`,
        raw: sql`'{}'::jsonb`,
      })
      .returning(["id", "disabled", "source_exported_at"])
      .executeTakeFirstOrThrow();

    expect(defaults.disabled).toBe(false);
    expect(defaults.source_exported_at).toBeNull();

    const exportedAt = new Date("2026-05-30T08:15:00Z");
    const explicit = await pg.db
      .insertInto("caches")
      .values({
        owner_id: ownerId,
        source: "gpx",
        source_id: "GC-DEF-2",
        code: "GCDEF2",
        type: "Traditional Cache",
        name: "explicit",
        location: sql`ST_SetSRID(ST_MakePoint(4.91, 52.31), 4326)::geography`,
        raw: sql`'{}'::jsonb`,
        disabled: true,
        source_exported_at: exportedAt,
      })
      .returning(["id", "disabled", "source_exported_at"])
      .executeTakeFirstOrThrow();

    expect(explicit.disabled).toBe(true);
    expect(explicit.source_exported_at?.toISOString()).toBe(
      exportedAt.toISOString(),
    );
  });

  it("excludes disabled + archived rows from the listCaches hot-path filter", async () => {
    // Insert three rows for a fresh owner so counts are deterministic.
    const owner = await pg.db
      .insertInto("users")
      .values({ email: "pr2-filter@gctp.local", display_name: "PR2Filter" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const insert = (suffix: string, archived: boolean, disabled: boolean) =>
      pg.db
        .insertInto("caches")
        .values({
          owner_id: owner.id,
          source: "gpx",
          source_id: `GC-FILT-${suffix}`,
          code: `GCFILT${suffix}`,
          type: "Traditional Cache",
          name: `filter-${suffix}`,
          location: sql`ST_SetSRID(ST_MakePoint(4.9, 52.3), 4326)::geography`,
          raw: sql`'{}'::jsonb`,
          archived,
          disabled,
        })
        .execute();

    await insert("A", false, false); // active
    await insert("B", false, true); // disabled
    await insert("C", true, false); // archived

    const active = await pg.db
      .selectFrom("caches")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("owner_id", "=", owner.id)
      .where("archived", "=", false)
      .where("disabled", "=", false)
      .executeTakeFirstOrThrow();

    expect(Number(active.n)).toBe(1);
  });

  it("gpx_uploads.exported_at defaults to NULL and round-trips a timestamp", async () => {
    const nullDefault = await pg.db
      .insertInto("gpx_uploads")
      .values({
        owner_id: ownerId,
        filename: "no-exported.gpx",
        status: "received",
      })
      .returning(["id", "exported_at"])
      .executeTakeFirstOrThrow();
    expect(nullDefault.exported_at).toBeNull();

    const exportedAt = new Date("2026-05-29T22:00:00Z");
    const withTs = await pg.db
      .insertInto("gpx_uploads")
      .values({
        owner_id: ownerId,
        filename: "with-exported.gpx",
        status: "received",
        exported_at: exportedAt,
      })
      .returning(["id", "exported_at"])
      .executeTakeFirstOrThrow();

    expect(withTs.exported_at?.toISOString()).toBe(exportedAt.toISOString());
  });
});
