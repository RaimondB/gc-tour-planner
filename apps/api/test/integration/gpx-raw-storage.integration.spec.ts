// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// End-to-end happy path for FR-T11 raw-upload preservation + admin reprocess:
//   ingest()  → upload row goes `received` → raw file on disk → `parsed`
//   reprocess() → reads raw → reparses → upserts → status stays `parsed`
//
// Real PostGIS via Testcontainers + a real tmp directory for storage. The
// BullMQ queue is the only thing stubbed (no Valkey to spin up); fire-and-
// forget enqueue is invoked but its result is ignored by the service.

import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GpxRepository } from "../../src/gpx/gpx.repository.js";
import { GpxService } from "../../src/gpx/gpx.service.js";
import { GpxStorageService } from "../../src/gpx/gpx-storage.service.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

const SAMPLE_GPX = new URL(
  "../../../../packages/shared/test/fixtures/sample-pq.gpx",
  import.meta.url,
);

describe("GPX raw storage + reprocess (PR1)", () => {
  let pg: PostgresFixture;
  let dir: string;
  let ownerId: string;
  let service: GpxService;
  const queueStub = { add: vi.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    pg = await startPostgres();
    dir = await mkdtemp(join(tmpdir(), "gctp-uploads-int-"));
    const user = await pg.db
      .insertInto("users")
      .values({ email: "raw@gctp.local", display_name: "Raw" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;
    const repo = new GpxRepository(pg.db);
    const storage = new GpxStorageService(dir);
    service = new GpxService(repo, storage, queueStub as unknown as Queue);
  });

  afterAll(async () => {
    await stopPostgres(pg);
    await rm(dir, { recursive: true, force: true });
  });

  it("ingest() persists the raw file and records size + sha256 + status=parsed", async () => {
    const xml = await readFile(SAMPLE_GPX, "utf8");
    const result = await service.ingest(ownerId, "sample.gpx", xml);
    expect(result.cachesUpserted).toBeGreaterThan(0);

    const row = await pg.db
      .selectFrom("gpx_uploads")
      .select(["id", "status", "raw_size_bytes", "raw_sha256", "parsed_count"])
      .where("id", "=", result.uploadId)
      .executeTakeFirstOrThrow();

    expect(row.status).toBe("parsed");
    expect(row.parsed_count).toBe(result.cachesUpserted);
    expect(row.raw_size_bytes).not.toBeNull();
    expect(Number(row.raw_size_bytes)).toBeGreaterThan(0);
    expect(row.raw_sha256).toMatch(/^[0-9a-f]{64}$/);

    // File is gzipped and smaller than the source XML.
    const gz = await readFile(join(dir, `${row.id}.gpx.gz`));
    expect(gz.byteLength).toBe(Number(row.raw_size_bytes));
    expect(gz.byteLength).toBeLessThan(Buffer.byteLength(xml, "utf8"));
  });

  it("reprocess() re-parses the stored raw and yields the same shape", async () => {
    const xml = await readFile(SAMPLE_GPX, "utf8");
    const initial = await service.ingest(ownerId, "for-reprocess.gpx", xml);

    const reprocessed = await service.reprocess(ownerId, initial.uploadId);
    expect(reprocessed.uploadId).toBe(initial.uploadId);
    expect(reprocessed.cachesUpserted).toBe(initial.cachesUpserted);
    expect(reprocessed.warnings).toEqual(initial.warnings);

    // Row stays `parsed` after reprocess — no orphan `received` state.
    const row = await pg.db
      .selectFrom("gpx_uploads")
      .select(["status", "parsed_count"])
      .where("id", "=", initial.uploadId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("parsed");
    expect(row.parsed_count).toBe(initial.cachesUpserted);
  });

  it("reprocess() returns 404 for a cross-owner upload id", async () => {
    // Insert a second user + an upload row owned by them.
    const other = await pg.db
      .insertInto("users")
      .values({ email: "other@gctp.local", display_name: "Other" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const foreignUpload = await pg.db
      .insertInto("gpx_uploads")
      .values({
        owner_id: other.id,
        filename: "foreign.gpx",
        status: "parsed",
        parsed_count: 0,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await expect(
      service.reprocess(ownerId, foreignUpload.id),
    ).rejects.toThrow(/not found/i);
  });

  it("reprocess() rejects an upload whose raw bytes were never stored", async () => {
    // Pre-existing row (predates raw storage) — both raw_* columns NULL.
    const legacy = await pg.db
      .insertInto("gpx_uploads")
      .values({
        owner_id: ownerId,
        filename: "legacy.gpx",
        status: "parsed",
        parsed_count: 0,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await expect(service.reprocess(ownerId, legacy.id)).rejects.toThrow(
      /no raw bytes stored/i,
    );
  });

  it("reprocess() re-upserts caches after they're deleted (the FR-T11 backfill scenario)", async () => {
    const xml = await readFile(SAMPLE_GPX, "utf8");
    const initial = await service.ingest(ownerId, "for-backfill.gpx", xml);
    expect(initial.cachesUpserted).toBeGreaterThan(0);

    // Wipe the cache rows for this owner (simulates a parser bug fix
    // that needs full re-upsert, or a schema migration that nulled
    // some column). The upload row + raw file stay intact.
    const deleted = await pg.db
      .deleteFrom("caches")
      .where("owner_id", "=", ownerId)
      .where("source", "=", "gpx")
      .returning("id")
      .execute();
    expect(deleted.length).toBeGreaterThan(0);

    const replayed = await service.reprocess(ownerId, initial.uploadId);
    expect(replayed.cachesUpserted).toBe(initial.cachesUpserted);
    const rowsAfter = await pg.db
      .selectFrom("caches")
      .select("id")
      .where("owner_id", "=", ownerId)
      .where("source", "=", "gpx")
      .execute();
    expect(rowsAfter.length).toBe(initial.cachesUpserted);
  });
});
