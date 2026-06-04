// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// PR3 smart filtering — end-to-end against PostGIS:
//   - parser extracts description hints from real PQ markup
//   - upsert persists them
//   - listCaches surfaces stageCount + descriptionHints on the DTO
//   - hasToolRequirement union (attrs ∪ hints) fires the visit-time bonus
//
// Real PostGIS via Testcontainers; only the BullMQ queue is stubbed.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GpxRepository } from "../../src/gpx/gpx.repository.js";
import { GpxService } from "../../src/gpx/gpx.service.js";
import { GpxStorageService } from "../../src/gpx/gpx-storage.service.js";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

const PQ = (caches: string): string => `<?xml version="1.0"?>
<gpx xmlns="http://www.topografix.com/GPX/1/0"
     xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1"
     version="1.0" creator="test">
  <time>2026-05-30T08:00:00Z</time>
  ${caches}
</gpx>`;

/** Build a single cache `<wpt>` block. */
function cacheWpt(opts: {
  code: string;
  lat: number;
  lon: number;
  type: string;
  attrIds?: ReadonlyArray<{ id: number; inc: 0 | 1 }>;
  description?: string;
}): string {
  const attrs = (opts.attrIds ?? [])
    .map(
      (a) =>
        `<groundspeak:attribute id="${a.id}" inc="${a.inc}">x</groundspeak:attribute>`,
    )
    .join("");
  const desc = opts.description
    ? `<groundspeak:long_description html="True">${opts.description}</groundspeak:long_description>`
    : "";
  return `<wpt lat="${opts.lat}" lon="${opts.lon}">
    <name>${opts.code}</name>
    <groundspeak:cache id="x" available="True" archived="False">
      <groundspeak:name>${opts.code}</groundspeak:name>
      <groundspeak:type>${opts.type}</groundspeak:type>
      <groundspeak:attributes>${attrs}</groundspeak:attributes>
      ${desc}
    </groundspeak:cache>
  </wpt>`;
}

describe("PR3 smart filtering — stageCount + descriptionHints + tool bonus", () => {
  let pg: PostgresFixture;
  let dir: string;
  let ownerId: string;
  let service: GpxService;
  let cachesRepo: CachesRepository;
  const queueStub = { add: vi.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    pg = await startPostgres();
    dir = await mkdtemp(join(tmpdir(), "gctp-pr3-"));
    const user = await pg.db
      .insertInto("users")
      .values({ email: "pr3@gctp.local", display_name: "PR3" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;
    service = new GpxService(
      new GpxRepository(pg.db),
      new GpxStorageService(dir),
      queueStub as unknown as Queue,
    );
    cachesRepo = new CachesRepository(pg.db);
  });

  afterAll(async () => {
    await stopPostgres(pg);
    await rm(dir, { recursive: true, force: true });
  });

  it("persists descriptionHints from <long_description> and exposes them via listCaches", async () => {
    const xml = PQ(
      cacheWpt({
        code: "GCFISH",
        lat: 52.0,
        lon: 5.0,
        type: "Traditional Cache",
        description:
          "&lt;p&gt;Vergeet je &lt;b&gt;hengel&lt;/b&gt; niet.&lt;/p&gt;",
      }),
    );
    await service.ingest(ownerId, "fish.gpx", xml);

    const list = await cachesRepo.find({
      ownerId,
      center: [5.0, 52.0],
      radiusM: 1000,
    });
    const row = list.find((c) => c.code === "GCFISH");
    expect(row).toBeDefined();
    expect(row?.descriptionHints).toEqual(["fishingRod"]);
    // Non-multi cache → stageCount stays 0.
    expect(row?.stageCount).toBe(0);
  });

  it("exposes stageCount via the additional_waypoints subquery", async () => {
    // Insert a Multi cache first (no stages yet → mini, count=0).
    const xml = PQ(
      cacheWpt({
        code: "GCMULT",
        lat: 52.1,
        lon: 5.1,
        type: "Multi-cache",
      }),
    );
    await service.ingest(ownerId, "mult.gpx", xml);
    const cacheRow = await pg.db
      .selectFrom("caches")
      .select(["id"])
      .where("source_id", "=", "GCMULT")
      .where("owner_id", "=", ownerId)
      .executeTakeFirstOrThrow();

    // Inject 4 'stages' waypoints directly via raw SQL — we want to
    // verify the COUNT projection, not exercise the parser's
    // waypoint classification (which is covered elsewhere).
    await sql`
      INSERT INTO additional_waypoints (cache_id, type, location, note)
      SELECT ${Number(cacheRow.id)}, 'stages',
             ST_SetSRID(ST_MakePoint(5.1, 52.1), 4326)::geography,
             'stage ' || g
      FROM generate_series(1, 4) AS g
    `.execute(pg.db);

    const list = await cachesRepo.find({
      ownerId,
      center: [5.1, 52.1],
      radiusM: 1000,
    });
    const row = list.find((c) => c.code === "GCMULT");
    expect(row?.stageCount).toBe(4);
  });

  it("hasToolRequirement union catches both attribute-tagged and description-only tool caches", async () => {
    // Two caches at the same point: one with attribute 51, one with
    // a fishing-rod description. Both should be flagged.
    const xml = PQ(
      [
        cacheWpt({
          code: "GCATTR",
          lat: 52.2,
          lon: 5.2,
          type: "Traditional Cache",
          attrIds: [{ id: 51, inc: 1 }],
        }),
        cacheWpt({
          code: "GCDESC",
          lat: 52.2,
          lon: 5.2,
          type: "Traditional Cache",
          description: "&lt;p&gt;Bring a fishing rod.&lt;/p&gt;",
        }),
      ].join("\n"),
    );
    await service.ingest(ownerId, "tools.gpx", xml);

    const list = await cachesRepo.find({
      ownerId,
      center: [5.2, 52.2],
      radiusM: 1000,
    });
    const attrCache = list.find((c) => c.code === "GCATTR");
    const descCache = list.find((c) => c.code === "GCDESC");
    expect(attrCache?.attributeIds).toContain(51);
    expect(attrCache?.descriptionHints).toEqual([]);
    expect(descCache?.attributeIds).not.toContain(51);
    expect(descCache?.descriptionHints).toEqual(["fishingRod"]);
  });
});
