// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// FR-I14 machine ingestion API. Exercises the IngestController → GpxService →
// repository path end-to-end against PostGIS via Testcontainers (no mocks —
// CLAUDE.md hard rule). Bearer-auth / 401 behaviour is unit-tested in
// ingest-auth.guard.spec.ts; here we prove the resolved actor's upload lands
// caches under the token owner and that re-ingest dedups (FR-I12).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GpxRepository } from "../../src/gpx/gpx.repository.js";
import { GpxService } from "../../src/gpx/gpx.service.js";
import { GpxStorageService } from "../../src/gpx/gpx-storage.service.js";
import { IngestController } from "../../src/ingest/ingest.controller.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

function makeGpx(code: string, name: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/0"
     xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1"
     version="1.0" creator="test">
  <time>2026-05-24T08:00:00Z</time>
  <wpt lat="52.0" lon="5.0">
    <name>${code}</name>
    <groundspeak:cache id="${code}" available="True" archived="False">
      <groundspeak:name>${name}</groundspeak:name>
      <groundspeak:type>Traditional Cache</groundspeak:type>
    </groundspeak:cache>
  </wpt>
</gpx>`;
}

function file(xml: string, name = "pq.gpx"): Express.Multer.File {
  return {
    originalname: name,
    buffer: Buffer.from(xml, "utf8"),
  } as Express.Multer.File;
}

describe("machine ingestion API (FR-I14)", () => {
  let pg: PostgresFixture;
  let dir: string;
  let ownerId: string;
  let controller: IngestController;
  const queueStub = { add: vi.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    pg = await startPostgres();
    dir = await mkdtemp(join(tmpdir(), "gctp-ingest-"));
    const user = await pg.db
      .insertInto("users")
      .values({ email: "ingest@gctp.local", display_name: "Ingest" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;
    const service = new GpxService(
      new GpxRepository(pg.db),
      new GpxStorageService(dir),
      queueStub as unknown as Queue,
    );
    controller = new IngestController(service);
  });

  afterAll(async () => {
    await stopPostgres(pg);
    await rm(dir, { recursive: true, force: true });
  });

  it("upserts caches under the token actor's owner", async () => {
    const result = await controller.upload(
      { ownerId },
      file(makeGpx("GC0I01", "Ingested cache")),
    );
    expect(result.stats.new).toBe(1);

    const row = await pg.db
      .selectFrom("caches")
      .select(["name", "owner_id", "source"])
      .where("source_id", "=", "GC0I01")
      .executeTakeFirstOrThrow();
    expect(row.owner_id).toBe(ownerId);
    expect(row.source).toBe("gpx");
    expect(row.name).toBe("Ingested cache");
  });

  it("dedups a byte-identical re-ingest (FR-I12)", async () => {
    const xml = makeGpx("GC0I02", "Dedup cache");
    const first = await controller.upload({ ownerId }, file(xml));
    expect(first.duplicate).toBe(false);

    const second = await controller.upload({ ownerId }, file(xml));
    expect(second.duplicate).toBe(true);

    const rows = await pg.db
      .selectFrom("caches")
      .select("id")
      .where("source_id", "=", "GC0I02")
      .where("owner_id", "=", ownerId)
      .execute();
    expect(rows).toHaveLength(1);
  });
});
