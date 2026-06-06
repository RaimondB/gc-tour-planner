// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CachesService } from "../../src/caches/caches.service.js";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";
import { makeGpxService } from "./integration-helpers.js";

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

    gpxService = makeGpxService(pg.db);

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
    // `force` bypasses the FR-I12 byte-identical dedup so we still exercise
    // the upsert path (dedup itself is covered in gpx-dedup.integration.spec).
    const second = await gpxService.ingest(ownerId, "sample-pq.gpx", xml, {
      force: true,
    });
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

  it("getDetail returns full detail for the owner and rejects another user's id", async () => {
    const all = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
    } as never);
    const target = all.caches[0];
    if (!target) throw new Error("test prerequisite: at least one cache");

    const detail = await cachesService.getDetail(ownerId, target.id);
    expect(detail.id).toBe(target.id);
    expect(detail.code).toBe(target.code);
    // Detail carries the popup-only fields the lean /caches list omits.
    expect(typeof detail.name).toBe("string");
    expect(Array.isArray(detail.attributeIds)).toBe(true);

    // Per-user GPX isolation: another user cannot read this cache's detail.
    const stranger = await pg.db
      .insertInto("users")
      .values({ email: "stranger@gctp.local", display_name: "Stranger" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await expect(
      cachesService.getDetail(stranger.id, target.id),
    ).rejects.toThrow();
  });

  it("marks-as-found via GPX upload and respects excludeFound", async () => {
    const xml = readFileSync(fixturePath, "utf8");

    const before = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
    } as never);
    expect(before.caches.every((c) => !c.foundByMe)).toBe(true);

    const findsIngest = await gpxService.ingest(ownerId, "my-finds.gpx", xml, {
      markAsFound: true,
      force: true, // same bytes as earlier uploads — bypass FR-I12 dedup
    });
    expect(findsIngest.findsRecorded).toBe(2);

    const all = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
    } as never);
    expect(all.caches.every((c) => c.foundByMe)).toBe(true);

    const excluded = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
      excludeFound: true,
    } as never);
    expect(excluded.caches).toEqual([]);

    // Re-running the find import is idempotent — no new rows. `force`
    // re-processes despite the FR-I12 dedup so we test finds idempotency,
    // not the dedup skip.
    const second = await gpxService.ingest(ownerId, "my-finds.gpx", xml, {
      markAsFound: true,
      force: true,
    });
    expect(second.findsRecorded).toBe(0);
  });

  it("manual mark/unmark via the caches service", async () => {
    // Take the first cache we see for this owner — could be GCAAA111 or GCBBB222.
    const all = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
    } as never);
    const target = all.caches[0];
    if (!target) throw new Error("test prerequisite: at least one cache");
    const cacheId = target.id;

    // Already marked-as-found from the previous test; unmark it.
    const removed = await cachesService.unmarkFound(ownerId, cacheId);
    expect(removed.removed).toBe(true);

    // After unmarking it's no longer found.
    const afterUnmark = await cachesService.list(ownerId, {
      center: [5.12, 52.09],
      radiusM: 5_000,
    } as never);
    expect(afterUnmark.caches.find((c) => c.id === cacheId)?.foundByMe).toBe(
      false,
    );

    // Re-mark via the service.
    const created = await cachesService.markFound(ownerId, cacheId);
    expect(created.created).toBe(true);

    // Idempotent second mark.
    const again = await cachesService.markFound(ownerId, cacheId);
    expect(again.created).toBe(false);
  });
});
