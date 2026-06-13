// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pins the semantics of `CachesRepository.nearestNeighbors` — the PostGIS k-NN
// over-fetch that feeds the Pass-1 walking graph. The method was rewritten from
// a one-round-trip-per-origin loop into a single CROSS JOIN LATERAL (profiling
// showed the serialised round-trips, not the index scan, dominated discovery
// latency). This guards that the batched query keeps the exact contract:
// per-origin k-nearest, owner-scoped, radius-bounded, self-excluded, and
// correct across a multi-origin batch. Real PostGIS, no mocks (per CLAUDE.md).

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

describe("CachesRepository.nearestNeighbors (batched LATERAL k-NN)", () => {
  let pg: PostgresFixture;
  let ownerId: string;
  let otherOwnerId: string;
  // A west→east line of caches ~111 m apart (0.001° lat-aligned lng step), so
  // walking distance order == index order and the k-nearest are unambiguous.
  const ids: number[] = []; // ids[i] sits at lng = 5 + i*0.001, lat 52
  let foreignId: number; // same spot as ids[0] but a different owner

  async function seed(
    owner: string,
    code: string,
    lng: number,
    lat: number,
  ): Promise<number> {
    const row = await pg.db
      .insertInto("caches")
      .values({
        owner_id: owner,
        source: "gpx",
        source_id: code,
        code,
        type: "Traditional",
        name: code,
        location: sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
        published_location: sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
        solved: false,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return Number(row.id);
  }

  beforeAll(async () => {
    pg = await startPostgres();
    const u1 = await pg.db
      .insertInto("users")
      .values({ email: "nn-owner@gctp.local", display_name: "NN Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = u1.id;
    const u2 = await pg.db
      .insertInto("users")
      .values({ email: "nn-other@gctp.local", display_name: "NN Other" })
      .returning("id")
      .executeTakeFirstOrThrow();
    otherOwnerId = u2.id;

    for (let i = 0; i < 8; i += 1) {
      ids.push(await seed(ownerId, `GCNN${i}`, 5 + i * 0.001, 52));
    }
    // A different owner's cache co-located with ids[0] — must never appear.
    foreignId = await seed(otherOwnerId, "GCFOREIGN", 5, 52);
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("returns the k walking-nearest owned neighbours, self excluded", async () => {
    const repo = new CachesRepository(pg.db);
    // Origin ids[3]; k=2 within a generous radius. Nearest two are its
    // immediate line neighbours ids[2] and ids[4] (~111 m each).
    const pairs = await repo.nearestNeighbors(ownerId, [ids[3]!], 2, 5_000);
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.fromCacheId === ids[3])).toBe(true);
    expect(pairs.map((p) => p.toCacheId).sort((a, b) => a - b)).toEqual(
      [ids[2]!, ids[4]!].sort((a, b) => a - b),
    );
    // Self is never a neighbour.
    expect(pairs.some((p) => p.toCacheId === ids[3])).toBe(false);
  });

  it("excludes other owners' caches", async () => {
    const repo = new CachesRepository(pg.db);
    const pairs = await repo.nearestNeighbors(ownerId, [ids[0]!], 8, 5_000);
    expect(pairs.some((p) => p.toCacheId === foreignId)).toBe(false);
    // Only the seven other owned caches are eligible.
    expect(pairs).toHaveLength(7);
  });

  it("respects the radius bound", async () => {
    const repo = new CachesRepository(pg.db);
    // A 0.001° lng step at lat 52° is ~68.5 m (111320·cos 52°). A 150 m radius
    // from ids[0] reaches ids[1] (~68 m) and ids[2] (~137 m); ids[3] (~206 m)
    // is out.
    const pairs = await repo.nearestNeighbors(ownerId, [ids[0]!], 8, 150);
    expect(pairs.map((p) => p.toCacheId).sort((a, b) => a - b)).toEqual(
      [ids[1]!, ids[2]!].sort((a, b) => a - b),
    );
  });

  it("batches every origin in a single call", async () => {
    const repo = new CachesRepository(pg.db);
    const origins = [ids[1]!, ids[5]!, ids[6]!];
    const pairs = await repo.nearestNeighbors(ownerId, origins, 2, 5_000);
    // Two neighbours per origin, every origin represented, none its own.
    for (const o of origins) {
      const mine = pairs.filter((p) => p.fromCacheId === o);
      expect(mine).toHaveLength(2);
      expect(mine.some((p) => p.toCacheId === o)).toBe(false);
    }
    expect(pairs).toHaveLength(origins.length * 2);
  });

  it("returns nothing for an empty origin set or non-positive k", async () => {
    const repo = new CachesRepository(pg.db);
    expect(await repo.nearestNeighbors(ownerId, [], 4, 5_000)).toEqual([]);
    expect(await repo.nearestNeighbors(ownerId, [ids[0]!], 0, 5_000)).toEqual(
      [],
    );
  });
});
