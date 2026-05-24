// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GpxService } from "../../src/gpx/gpx.service.js";
import { GpxRepository } from "../../src/gpx/gpx.repository.js";
import { CachesService } from "../../src/caches/caches.service.js";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../../packages/shared/test/fixtures/sample-pq.gpx",
    import.meta.url,
  ),
);

describe("M2 caches + gpx integration (PostGIS via Testcontainers)", () => {
  let pg: PostgresFixture;
  let ownerId: string;
  let gpxService: GpxService;
  let cachesService: CachesService;

  beforeAll(async () => {
    pg = await startPostgres();

    const user = await pg.db
      .insertInto("users")
      .values({ email: "owner@gctp.local", display_name: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = user.id;

    const gpxRepo = new GpxRepository(pg.db);
    gpxService = new GpxService(gpxRepo);

    const cacheRepo = new CachesRepository(pg.db);
    cachesService = new CachesService(cacheRepo);
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("ingests the sample PQ, then lists caches filtered by radius + type + attribute", async () => {
    const xml = readFileSync(fixturePath, "utf8");
    const ingest = await gpxService.ingest(ownerId, "sample-pq.gpx", xml);
    expect(ingest.cachesUpserted).toBe(2);
    expect(ingest.waypointsInserted).toBe(3);
    expect(ingest.warnings).toEqual([]);

    const all = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
      softPreferences: undefined,
    } as never);
    // softPreferences is a tour-planner concern, not /caches; the shape coercion
    // above (`as never`) intentionally bypasses the validator-default workaround
    // since we are calling the service directly.
    expect(all.caches).toHaveLength(2);

    const codes = all.caches.map((c) => c.code).sort();
    expect(codes).toEqual(["GCAAA111", "GCBBB222"]);

    const traditional = all.caches.find((c) => c.code === "GCAAA111");
    expect(traditional?.type).toBe("Traditional");
    expect(traditional?.parkingPoints).toEqual([[5.123, 52.092]]);
    expect(traditional?.attributeIds).toEqual([6, 40]);

    const tradOnly = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
      types: ["Traditional"],
    } as never);
    expect(tradOnly.caches.map((c) => c.code)).toEqual(["GCAAA111"]);

    const dogAllowed = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
      attributes: [[{ id: 6, positive: true }]],
    } as never);
    expect(dogAllowed.caches.map((c) => c.code)).toEqual(["GCAAA111"]);

    const empty = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 100,
    } as never);
    expect(empty.caches).toEqual([]);
  });

  it("re-uploading the same GPX updates rather than duplicates", async () => {
    const xml = readFileSync(fixturePath, "utf8");
    const second = await gpxService.ingest(ownerId, "sample-pq.gpx", xml);
    expect(second.cachesUpserted).toBe(2);

    const all = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
    } as never);
    expect(all.caches).toHaveLength(2);
  });

  it("isolates by owner: a different user sees nothing", async () => {
    const other = await pg.db
      .insertInto("users")
      .values({ email: "other@gctp.local", display_name: "Other" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const empty = await cachesService.list(other.id, {
      center: [5.12, 52.09],
      radiusM: 5_000,
    } as never);
    expect(empty.caches).toEqual([]);
  });
});
