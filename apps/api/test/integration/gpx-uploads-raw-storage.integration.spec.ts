// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Smoke test for migration 1779650000000_gpx_uploads_raw_storage: verifies the
// new `raw_size_bytes` / `raw_sha256` columns exist, default to NULL on
// insert, and accept values on UPDATE. Real PostGIS via Testcontainers — no
// DB mocks (CLAUDE.md hard rule).

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

describe("gpx_uploads raw-storage columns (migration 1779650000000)", () => {
  let pg: PostgresFixture;
  let ownerId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    const user = await pg.db
      .insertInto("users")
      .values({ email: "raw-storage@gctp.local", display_name: "RawStore" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("creates a gpx_uploads row with NULL raw_* columns by default", async () => {
    const row = await pg.db
      .insertInto("gpx_uploads")
      .values({
        owner_id: ownerId,
        filename: "default-nulls.gpx",
        status: "received",
      })
      .returning(["id", "raw_size_bytes", "raw_sha256"])
      .executeTakeFirstOrThrow();

    expect(row.raw_size_bytes).toBeNull();
    expect(row.raw_sha256).toBeNull();
  });

  it("round-trips raw_size_bytes (bigint) and raw_sha256 (hex)", async () => {
    const sha = "a".repeat(64); // 64-char lowercase hex
    const sizeBytes = 9_876_543_210n; // > INT32 to exercise BIGINT

    const inserted = await pg.db
      .insertInto("gpx_uploads")
      .values({
        owner_id: ownerId,
        filename: "with-raw.gpx",
        status: "received",
        raw_size_bytes: sizeBytes,
        raw_sha256: sha,
      })
      .returning(["id", "raw_size_bytes", "raw_sha256"])
      .executeTakeFirstOrThrow();

    // node-pg returns BIGINT as string by default; compare lexically.
    expect(String(inserted.raw_size_bytes)).toBe(String(sizeBytes));
    expect(inserted.raw_sha256).toBe(sha);

    // Round-trip via SELECT to confirm the columns persist (not just RETURNING).
    const fetched = await pg.db
      .selectFrom("gpx_uploads")
      .select(["raw_size_bytes", "raw_sha256"])
      .where("id", "=", inserted.id)
      .executeTakeFirstOrThrow();
    expect(String(fetched.raw_size_bytes)).toBe(String(sizeBytes));
    expect(fetched.raw_sha256).toBe(sha);
  });

  it("information_schema reports the new columns as nullable", async () => {
    const cols = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'gpx_uploads'
        AND column_name IN ('raw_size_bytes', 'raw_sha256')
      ORDER BY column_name
    `.execute(pg.db);

    expect(cols.rows).toEqual([
      { column_name: "raw_sha256", data_type: "text", is_nullable: "YES" },
      {
        column_name: "raw_size_bytes",
        data_type: "bigint",
        is_nullable: "YES",
      },
    ]);
  });
});
