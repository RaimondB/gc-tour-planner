// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// FR-I13 solved / corrected coordinates. End-to-end against PostGIS via
// Testcontainers — no mocks (CLAUDE.md hard rule). Covers: the solved upload
// writing `location` + `solved` while preserving `published_location`, the
// PQ-coexistence clobber-guard, the staleness-guard bypass, any-type support,
// the "only solved mysteries" filter SQL, route_legs invalidation on
// relocation, and the remove-solved revert.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import { GpxService } from "../../src/gpx/gpx.service.js";
import { fakeWalkingQueue, makeCachesService } from "./integration-helpers.js";
import { GpxRepository } from "../../src/gpx/gpx.repository.js";
import { GpxStorageService } from "../../src/gpx/gpx-storage.service.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

/** Build a 1-cache GPX with a known type, coordinate, and exportedAt. */
function makeGpx(opts: {
  exportedAt: string;
  code: string;
  name: string;
  type: string; // Groundspeak type string, e.g. "Unknown Cache"
  lat: number;
  lon: number;
}): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/0"
     xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1"
     version="1.0" creator="test">
  <time>${opts.exportedAt}</time>
  <wpt lat="${opts.lat}" lon="${opts.lon}">
    <name>${opts.code}</name>
    <groundspeak:cache id="${opts.code}" available="True" archived="False">
      <groundspeak:name>${opts.name}</groundspeak:name>
      <groundspeak:type>${opts.type}</groundspeak:type>
    </groundspeak:cache>
  </wpt>
</gpx>`;
}

/** Read the coordinate + solved columns for a cache code, owner-scoped. */
async function readCache(pg: PostgresFixture, ownerId: string, code: string) {
  const row = await pg.db
    .selectFrom("caches")
    .select((eb) => [
      "id",
      "solved",
      "solved_at",
      sql<number>`ST_X(location::geometry)`.as("lng"),
      sql<number>`ST_Y(location::geometry)`.as("lat"),
      sql<number | null>`ST_X(published_location::geometry)`.as("plng"),
      sql<number | null>`ST_Y(published_location::geometry)`.as("plat"),
    ])
    .where("owner_id", "=", ownerId)
    .where("source_id", "=", code)
    .executeTakeFirstOrThrow();
  return {
    id: Number(row.id),
    solved: row.solved,
    solvedAt: row.solved_at,
    lng: Number(row.lng.toFixed(4)),
    lat: Number(row.lat.toFixed(4)),
    plng: row.plng === null ? null : Number(row.plng.toFixed(4)),
    plat: row.plat === null ? null : Number(row.plat.toFixed(4)),
  };
}

describe("GPX solved / corrected coordinates (FR-I13)", () => {
  let pg: PostgresFixture;
  let dir: string;
  let ownerId: string;
  let service: GpxService;

  beforeAll(async () => {
    pg = await startPostgres();
    dir = await mkdtemp(join(tmpdir(), "gctp-solved-"));
    const user = await pg.db
      .insertInto("users")
      .values({ email: "solved@gctp.local", display_name: "Solver" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;
    service = new GpxService(
      new GpxRepository(pg.db),
      new GpxStorageService(dir),
      fakeWalkingQueue(),
    );
  });

  afterAll(async () => {
    await stopPostgres(pg);
    await rm(dir, { recursive: true, force: true });
  });

  it("normal PQ stores the posted coord, solved=false", async () => {
    await service.ingest(
      ownerId,
      "posted.gpx",
      makeGpx({
        exportedAt: "2026-06-01T08:00:00Z",
        code: "GCMYS1",
        name: "Puzzle",
        type: "Unknown Cache",
        lat: 52.0,
        lon: 5.0,
      }),
    );
    const c = await readCache(pg, ownerId, "GCMYS1");
    expect(c.solved).toBe(false);
    expect([c.lng, c.lat]).toEqual([5.0, 52.0]);
    expect([c.plng, c.plat]).toEqual([5.0, 52.0]); // published == posted
  });

  it("solved upload sets location to corrected coord, preserves published", async () => {
    const result = await service.ingest(
      ownerId,
      "solved.gpx",
      makeGpx({
        exportedAt: "2026-06-02T08:00:00Z",
        code: "GCMYS1",
        name: "Puzzle (solved export)",
        type: "Unknown Cache",
        lat: 52.1,
        lon: 5.1,
      }),
      { solvedCoordinates: true },
    );
    expect(result.cachesUpserted).toBe(1);

    const c = await readCache(pg, ownerId, "GCMYS1");
    expect(c.solved).toBe(true);
    expect(c.solvedAt).not.toBeNull();
    expect([c.lng, c.lat]).toEqual([5.1, 52.1]); // location = corrected
    expect([c.plng, c.plat]).toEqual([5.0, 52.0]); // posted preserved
  });

  it("PQ coexistence: a later normal PQ refreshes published but never the solved location", async () => {
    // Same code, normal upload (force past byte-dedup), posted coords shifted
    // slightly to a new posted location — must not touch the solved location.
    await service.ingest(
      ownerId,
      "posted-again.gpx",
      makeGpx({
        exportedAt: "2026-06-10T08:00:00Z",
        code: "GCMYS1",
        name: "Puzzle (weekly PQ)",
        type: "Unknown Cache",
        lat: 52.02,
        lon: 5.02,
      }),
      { force: true },
    );
    const c = await readCache(pg, ownerId, "GCMYS1");
    expect(c.solved).toBe(true);
    expect([c.lng, c.lat]).toEqual([5.1, 52.1]); // solved location unchanged
    expect([c.plng, c.plat]).toEqual([5.02, 52.02]); // published refreshed
  });

  it("solved upload bypasses the staleness guard (older <time> still applies)", async () => {
    await service.ingest(
      ownerId,
      "posted2.gpx",
      makeGpx({
        exportedAt: "2026-06-05T08:00:00Z",
        code: "GCMYS2",
        name: "Puzzle 2",
        type: "Unknown Cache",
        lat: 52.0,
        lon: 5.0,
      }),
    );
    // Solved file with an OLDER export time than the row's source_exported_at.
    const result = await service.ingest(
      ownerId,
      "solved-old.gpx",
      makeGpx({
        exportedAt: "2026-06-03T08:00:00Z", // older
        code: "GCMYS2",
        name: "Puzzle 2 (old solved export)",
        type: "Unknown Cache",
        lat: 52.2,
        lon: 5.2,
      }),
      { solvedCoordinates: true },
    );
    expect(result.cachesUpserted).toBe(1);
    const c = await readCache(pg, ownerId, "GCMYS2");
    expect(c.solved).toBe(true);
    expect([c.lng, c.lat]).toEqual([5.2, 52.2]);
  });

  it("applies to any type — a Multi final location is solved too", async () => {
    await service.ingest(
      ownerId,
      "multi.gpx",
      makeGpx({
        exportedAt: "2026-06-06T08:00:00Z",
        code: "GCMUL1",
        name: "A multi",
        type: "Multi-cache",
        lat: 52.0,
        lon: 5.0,
      }),
      { solvedCoordinates: true },
    );
    const c = await readCache(pg, ownerId, "GCMUL1");
    expect(c.solved).toBe(true);
  });

  it("solvedMysteriesOnly filter drops only unsolved mysteries", async () => {
    // Add an UNSOLVED mystery + a traditional, near the others.
    await service.ingest(
      ownerId,
      "unsolved.gpx",
      makeGpx({
        exportedAt: "2026-06-06T08:00:00Z",
        code: "GCUNS1",
        name: "Unsolved puzzle",
        type: "Unknown Cache",
        lat: 52.0,
        lon: 5.0,
      }),
    );
    await service.ingest(
      ownerId,
      "trad.gpx",
      makeGpx({
        exportedAt: "2026-06-06T08:00:00Z",
        code: "GCTRA1",
        name: "A traditional",
        type: "Traditional Cache",
        lat: 52.0,
        lon: 5.0,
      }),
    );

    const repo = new CachesRepository(pg.db);
    const filtered = await repo.find({
      ownerId,
      center: [5.0, 52.0],
      radiusM: 50_000,
      solvedMysteriesOnly: true,
    });
    const codes = filtered.map((c) => c.code).sort();
    // GCUNS1 (unsolved mystery) is dropped; GCMYS1/GCMYS2 (solved mysteries),
    // GCMUL1 (multi), and GCTRA1 (traditional) all survive.
    expect(codes).not.toContain("GCUNS1");
    expect(codes).toContain("GCMYS1");
    expect(codes).toContain("GCMYS2");
    expect(codes).toContain("GCTRA1");

    // The DTO exposes solved + the posted coord for solved rows.
    const solvedDto = filtered.find((c) => c.code === "GCMYS1");
    expect(solvedDto?.solved).toBe(true);
    expect(solvedDto?.postedLocation).toEqual({
      type: "Point",
      coordinates: [5.02, 52.02],
    });
  });

  it("relocation invalidates the cache's route_legs, and remove-solved reverts the location", async () => {
    // Seed a route_leg from a freshly-uploaded mystery to a neighbour, then a
    // solved upload that moves the mystery must delete that stale leg.
    await service.ingest(
      ownerId,
      "reloc-a.gpx",
      makeGpx({
        exportedAt: "2026-06-07T08:00:00Z",
        code: "GCREL1",
        name: "Reloc mystery",
        type: "Unknown Cache",
        lat: 52.0,
        lon: 5.0,
      }),
    );
    await service.ingest(
      ownerId,
      "reloc-b.gpx",
      makeGpx({
        exportedAt: "2026-06-07T08:00:00Z",
        code: "GCREL2",
        name: "Neighbour",
        type: "Traditional Cache",
        lat: 52.001,
        lon: 5.001,
      }),
    );
    const a = await readCache(pg, ownerId, "GCREL1");
    const b = await readCache(pg, ownerId, "GCREL2");
    await pg.db
      .insertInto("route_legs")
      .values({
        from_cache_id: a.id,
        to_cache_id: b.id,
        profile: "foot",
        meters: 120,
        seconds: 90,
        source: "table",
        osrm_version: "test",
      })
      .execute();

    // Solved upload relocates GCREL1 far away → its leg is now stale.
    await service.ingest(
      ownerId,
      "reloc-solved.gpx",
      makeGpx({
        exportedAt: "2026-06-08T08:00:00Z",
        code: "GCREL1",
        name: "Reloc mystery (solved)",
        type: "Unknown Cache",
        lat: 52.5,
        lon: 5.5,
      }),
      { solvedCoordinates: true },
    );
    const legsAfter = await pg.db
      .selectFrom("route_legs")
      .select(["from_cache_id"])
      .where((eb) =>
        eb.or([eb("from_cache_id", "=", a.id), eb("to_cache_id", "=", a.id)]),
      )
      .execute();
    expect(legsAfter).toHaveLength(0); // stale leg deleted

    // Remove-solved reverts the location to the posted coord.
    const caches = makeCachesService(pg.db);
    const res = await caches.clearSolved(ownerId, a.id);
    expect(res.cleared).toBe(true);
    const reverted = await readCache(pg, ownerId, "GCREL1");
    expect(reverted.solved).toBe(false);
    expect(reverted.solvedAt).toBeNull();
    expect([reverted.lng, reverted.lat]).toEqual([5.0, 52.0]); // back to posted
  });
});
