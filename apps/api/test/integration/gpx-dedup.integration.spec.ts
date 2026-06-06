// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// FR-I12 — per-user upload dedup. A byte-identical re-upload by the same
// owner is skipped (no new gpx_uploads row, no second file on disk, no
// re-parse); `force` re-processes the existing upload instead. Dedup is
// scoped to the owner, so a different user uploading the same bytes is
// processed normally.
//
// Real PostGIS via Testcontainers + a real tmp dir for storage; the BullMQ
// queue is stubbed (fire-and-forget enqueue, result ignored).

import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
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

async function countUploads(
  pg: PostgresFixture,
  ownerId: string,
): Promise<number> {
  const rows = await pg.db
    .selectFrom("gpx_uploads")
    .select("id")
    .where("owner_id", "=", ownerId)
    .execute();
  return rows.length;
}

describe("GPX upload dedup (FR-I12)", () => {
  let pg: PostgresFixture;
  let dir: string;
  let ownerId: string;
  let service: GpxService;
  let xml: string;
  const queueStub = { add: vi.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    pg = await startPostgres();
    dir = await mkdtemp(join(tmpdir(), "gctp-dedup-int-"));
    xml = await readFile(SAMPLE_GPX, "utf8");
    const user = await pg.db
      .insertInto("users")
      .values({ email: "dedup@gctp.local", display_name: "Dedup" })
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

  it("first upload processes; an identical re-upload is skipped as a duplicate", async () => {
    const first = await service.ingest(ownerId, "sample.gpx", xml);
    expect(first.duplicate).toBe(false);
    expect(first.cachesUpserted).toBeGreaterThan(0);

    const uploadsAfterFirst = await countUploads(pg, ownerId);
    const filesAfterFirst = (await readdir(dir)).length;

    const second = await service.ingest(ownerId, "sample-again.gpx", xml);
    expect(second.duplicate).toBe(true);
    // Points at the existing upload, with no work done.
    expect(second.uploadId).toBe(first.uploadId);
    expect(second.cachesUpserted).toBe(0);
    expect(second.stats.total).toBe(0);

    // No new upload row, no second file on disk.
    expect(await countUploads(pg, ownerId)).toBe(uploadsAfterFirst);
    expect((await readdir(dir)).length).toBe(filesAfterFirst);
  });

  it("force re-processes the existing upload without storing a second copy", async () => {
    const uploadsBefore = await countUploads(pg, ownerId);
    const filesBefore = (await readdir(dir)).length;

    const forced = await service.ingest(ownerId, "sample.gpx", xml, {
      force: true,
    });
    expect(forced.duplicate).toBe(false);
    // Re-used the existing upload row; no new row, no new file.
    expect(await countUploads(pg, ownerId)).toBe(uploadsBefore);
    expect((await readdir(dir)).length).toBe(filesBefore);

    const row = await pg.db
      .selectFrom("gpx_uploads")
      .select(["status"])
      .where("id", "=", forced.uploadId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("parsed");
  });

  it("a different user uploading the same bytes is not a duplicate", async () => {
    const other = await pg.db
      .insertInto("users")
      .values({ email: "dedup-other@gctp.local", display_name: "Other" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const result = await service.ingest(other.id, "sample.gpx", xml);
    expect(result.duplicate).toBe(false);
    expect(result.cachesUpserted).toBeGreaterThan(0);
    expect(await countUploads(pg, other.id)).toBe(1);
  });
});
