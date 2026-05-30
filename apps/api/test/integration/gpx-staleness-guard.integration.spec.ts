// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// FR-I10 staleness guard + FR-I11 upload stats. End-to-end against
// PostGIS via Testcontainers — no mocks (CLAUDE.md hard rule).

import { mkdtemp, rm } from "node:fs/promises";
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

/** Build a 1-cache GPX with a known exportedAt + available/archived state. */
function makeGpx(opts: {
  exportedAt: string;
  code: string;
  name: string;
  available: boolean;
  archived?: boolean;
}): string {
  const archived = opts.archived ?? false;
  return `<?xml version="1.0" encoding="utf-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/0"
     xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1"
     version="1.0" creator="test">
  <time>${opts.exportedAt}</time>
  <wpt lat="52.0" lon="5.0">
    <name>${opts.code}</name>
    <groundspeak:cache id="${opts.code}" available="${opts.available ? "True" : "False"}" archived="${archived ? "True" : "False"}">
      <groundspeak:name>${opts.name}</groundspeak:name>
      <groundspeak:type>Traditional Cache</groundspeak:type>
    </groundspeak:cache>
  </wpt>
</gpx>`;
}

describe("GPX staleness guard + upload stats (PR2)", () => {
  let pg: PostgresFixture;
  let dir: string;
  let ownerId: string;
  let service: GpxService;
  const queueStub = { add: vi.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    pg = await startPostgres();
    dir = await mkdtemp(join(tmpdir(), "gctp-staleness-"));
    const user = await pg.db
      .insertInto("users")
      .values({ email: "stale@gctp.local", display_name: "Stale" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;
    service = new GpxService(
      new GpxRepository(pg.db),
      new GpxStorageService(dir),
      queueStub as unknown as Queue,
    );
  });

  afterAll(async () => {
    await stopPostgres(pg);
    await rm(dir, { recursive: true, force: true });
  });

  it("first upload writes the cache + records exportedAt as source_exported_at", async () => {
    const result = await service.ingest(
      ownerId,
      "first.gpx",
      makeGpx({
        exportedAt: "2026-05-24T08:00:00Z",
        code: "GC0001",
        name: "Initial Name",
        available: true,
      }),
    );
    expect(result.stats).toMatchObject({
      total: 1,
      new: 1,
      updated: 0,
      stale: 0,
      disabled: 0,
      archived: 0,
      byType: { Traditional: 1 },
      exportedAt: "2026-05-24T08:00:00.000Z",
    });

    const row = await pg.db
      .selectFrom("caches")
      .select(["name", "disabled", "source_exported_at"])
      .where("source_id", "=", "GC0001")
      .where("owner_id", "=", ownerId)
      .executeTakeFirstOrThrow();
    expect(row.name).toBe("Initial Name");
    expect(row.disabled).toBe(false);
    expect(row.source_exported_at?.toISOString()).toBe(
      "2026-05-24T08:00:00.000Z",
    );
  });

  it("older PQ is skipped — staleness guard reports stale and does NOT overwrite", async () => {
    const result = await service.ingest(
      ownerId,
      "older.gpx",
      makeGpx({
        exportedAt: "2026-05-20T08:00:00Z", // older than first upload
        code: "GC0001",
        name: "Older Name (should not stick)",
        available: true,
      }),
    );
    expect(result.stats.stale).toBe(1);
    expect(result.stats.new).toBe(0);
    expect(result.stats.updated).toBe(0);

    const row = await pg.db
      .selectFrom("caches")
      .select(["name", "source_exported_at"])
      .where("source_id", "=", "GC0001")
      .where("owner_id", "=", ownerId)
      .executeTakeFirstOrThrow();
    // The old PQ did not win — name + source_exported_at unchanged
    // from the first upload.
    expect(row.name).toBe("Initial Name");
    expect(row.source_exported_at?.toISOString()).toBe(
      "2026-05-24T08:00:00.000Z",
    );
  });

  it("newer PQ wins — updates the row and bumps source_exported_at", async () => {
    const result = await service.ingest(
      ownerId,
      "newer.gpx",
      makeGpx({
        exportedAt: "2026-05-30T08:00:00Z", // newer
        code: "GC0001",
        name: "Newer Name (this one sticks)",
        available: false, // also flip to disabled
      }),
    );
    expect(result.stats.updated).toBe(1);
    expect(result.stats.stale).toBe(0);
    expect(result.stats.disabled).toBe(1);

    const row = await pg.db
      .selectFrom("caches")
      .select(["name", "disabled", "archived", "source_exported_at"])
      .where("source_id", "=", "GC0001")
      .where("owner_id", "=", ownerId)
      .executeTakeFirstOrThrow();
    expect(row.name).toBe("Newer Name (this one sticks)");
    expect(row.disabled).toBe(true);
    expect(row.archived).toBe(false);
    expect(row.source_exported_at?.toISOString()).toBe(
      "2026-05-30T08:00:00.000Z",
    );
  });

  it("default listCaches hides disabled + archived; includeDisabled flips it back on", async () => {
    // GC0001 is currently disabled from the last test. Add an
    // archived sibling + an active one to round out the matrix.
    await service.ingest(
      ownerId,
      "active.gpx",
      makeGpx({
        exportedAt: "2026-05-30T08:00:00Z",
        code: "GC0ACT",
        name: "Active cache",
        available: true,
      }),
    );
    await service.ingest(
      ownerId,
      "archived.gpx",
      makeGpx({
        exportedAt: "2026-05-30T08:00:00Z",
        code: "GC0ARC",
        name: "Archived cache",
        available: false,
        archived: true,
      }),
    );

    // Inline repo call — the controller wiring is exercised in
    // caches.integration.spec.ts; here we verify the WHERE behaviour.
    const { CachesRepository } = await import(
      "../../src/caches/caches.repository.js"
    );
    const repo = new CachesRepository(pg.db);

    const defaultList = await repo.find({
      ownerId,
      center: [5.0, 52.0],
      radiusM: 50_000,
    });
    const defaultCodes = defaultList.map((c) => c.code).sort();
    expect(defaultCodes).toEqual(["GC0ACT"]);

    const withDisabled = await repo.find({
      ownerId,
      center: [5.0, 52.0],
      radiusM: 50_000,
      includeDisabled: true,
    });
    const withDisabledCodes = withDisabled.map((c) => c.code).sort();
    expect(withDisabledCodes).toEqual(["GC0001", "GC0ACT"]);
    expect(
      withDisabled.find((c) => c.code === "GC0001")?.disabled,
    ).toBe(true);

    const withAll = await repo.find({
      ownerId,
      center: [5.0, 52.0],
      radiusM: 50_000,
      includeDisabled: true,
      includeArchived: true,
    });
    expect(withAll.map((c) => c.code).sort()).toEqual([
      "GC0001",
      "GC0ACT",
      "GC0ARC",
    ]);
  });

  it("GPX with no top-level <time> degrades to 'always allow update' (exportedAt=null)", async () => {
    const xml = `<?xml version="1.0"?>
<gpx xmlns="http://www.topografix.com/GPX/1/0"
     xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
  <wpt lat="52.0" lon="5.0">
    <name>GC0NULL</name>
    <groundspeak:cache id="x" available="True" archived="False">
      <groundspeak:name>No time</groundspeak:name>
      <groundspeak:type>Traditional Cache</groundspeak:type>
    </groundspeak:cache>
  </wpt>
</gpx>`;
    const first = await service.ingest(ownerId, "no-time.gpx", xml);
    expect(first.stats.exportedAt).toBeNull();
    expect(first.stats.new).toBe(1);

    // Re-upload with even-older actual date doesn't matter — null
    // exportedAt on either side disables the staleness comparison.
    const second = await service.ingest(ownerId, "no-time-2.gpx", xml);
    expect(second.stats.updated).toBe(1);
    expect(second.stats.stale).toBe(0);
  });
});
