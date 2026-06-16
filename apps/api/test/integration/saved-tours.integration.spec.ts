// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Tours } from "@gctp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import { SavedToursRepository } from "../../src/tours/saved-tours.repository.js";
import { SavedToursService } from "../../src/tours/saved-tours.service.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

async function insertCache(
  fixture: PostgresFixture,
  ownerId: string,
  code: string,
  lng: number,
  lat: number,
): Promise<number> {
  const row = await fixture.db
    .insertInto("caches")
    .values({
      owner_id: ownerId,
      source: "gpx",
      source_id: code,
      code,
      type: "Traditional",
      name: `${code} test`,
      location: sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
      raw: { test: true },
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

/** Minimal valid PlanResult over the supplied caches, parked at `parkAt`. */
function makePlan(
  cacheIds: number[],
  parkAt: [number, number],
  opts: { fallback?: boolean; meters?: number; seconds?: number } = {},
): Tours.PlanResult {
  return {
    orderedCacheIds: cacheIds,
    droppedCacheIds: [],
    polyline: {
      type: "LineString",
      coordinates: [parkAt, [parkAt[0] + 0.001, parkAt[1]], parkAt],
    },
    totals: {
      meters: opts.meters ?? 1234.5,
      seconds: opts.seconds ?? 678.9,
      visitMinutes: 10,
    },
    parking: {
      type: opts.fallback ? "osrm-nearest" : "user",
      point: { type: "Point", coordinates: parkAt },
      reason: "test",
      fallback: opts.fallback ?? false,
    },
    scoreBreakdown: { density: 0.8, budgetFit: 1 },
    legs: [],
  };
}

describe("M6-γ saved-tours persistence (PostGIS via Testcontainers)", () => {
  let pg: PostgresFixture;
  let service: SavedToursService;
  let ownerId: string;
  let otherId: string;
  let cacheIds: number[];
  const park: [number, number] = [5.12, 52.09];

  beforeAll(async () => {
    pg = await startPostgres();

    const owner = await pg.db
      .insertInto("users")
      .values({ email: "m6g@gctp.local", display_name: "M6γ Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = owner.id;
    const other = await pg.db
      .insertInto("users")
      .values({ email: "m6g-other@gctp.local", display_name: "Other" })
      .returning("id")
      .executeTakeFirstOrThrow();
    otherId = other.id;

    cacheIds = [
      await insertCache(pg, ownerId, "GCM6G01", 5.12, 52.09),
      await insertCache(pg, ownerId, "GCM6G02", 5.122, 52.091),
    ];

    service = new SavedToursService(
      new SavedToursRepository(pg.db),
      new CachesRepository(pg.db),
    );
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("save persists typed columns, the stored plan, and a baked cache snapshot", async () => {
    // Parse through the wire schema first, exactly as the controller does — so
    // the name trim (a schema concern, not the service's) is exercised too.
    const input = Tours.SaveTourInput.parse({
      name: "  Forest loop  ",
      plan: makePlan(cacheIds, park, { meters: 1234.5, seconds: 678.9 }),
    });
    const detail = await service.save(ownerId, input);

    // Wire shape is valid.
    expect(() => Tours.SavedTourDetail.parse(detail)).not.toThrow();

    expect(detail.name).toBe("Forest loop"); // trimmed by SaveTourInput
    expect(detail.totalMeters).toBeCloseTo(1234.5, 1);
    expect(detail.totalSeconds).toBeCloseTo(678.9, 1);
    expect(detail.cacheCount).toBe(2);
    expect(detail.isShared).toBe(false);
    expect(detail.startPoint.coordinates).toEqual(park);
    // parking_point set (not a fallback).
    expect(detail.parkingPoint?.coordinates).toEqual(park);
    // The denormalised snapshot carries both owned caches.
    expect(detail.plan.caches).toHaveLength(2);
    expect(new Set(detail.plan.caches.map((c) => c.id))).toEqual(
      new Set(cacheIds),
    );
    expect(detail.plan.caches[0]).toHaveProperty("code");
    expect(detail.plan.caches[0]).toHaveProperty("location");
    // The full PlanResult survived the round-trip.
    expect(detail.plan.orderedCacheIds).toEqual(cacheIds);
    expect(detail.plan.scoreBreakdown).toEqual({ density: 0.8, budgetFit: 1 });
  });

  it("parking_point is NULL when the planner fell back to the centroid", async () => {
    const detail = await service.save(ownerId, {
      name: "Fallback tour",
      plan: makePlan(cacheIds, park, { fallback: true }),
    });
    expect(detail.parkingPoint).toBeNull();
    // start_point is still set — it's the loop anchor.
    expect(detail.startPoint.coordinates).toEqual(park);
  });

  it("list is owner-scoped, newest-first, with lean summaries", async () => {
    const list = await service.list(ownerId);
    // Two tours saved above, newest (Fallback tour) first.
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0]!.name).toBe("Fallback tour");
    expect(list.every((t) => t.isShared === false)).toBe(true);
    // Other user sees none of them.
    expect(await service.list(otherId)).toHaveLength(0);
  });

  it("getById returns full detail for the owner, 404 cross-tenant", async () => {
    const saved = await service.save(ownerId, {
      name: "Openable",
      plan: makePlan(cacheIds, park),
    });
    const fetched = await service.getById(ownerId, saved.id);
    expect(fetched.id).toBe(saved.id);
    expect(fetched.plan.caches).toHaveLength(2);

    await expect(service.getById(otherId, saved.id)).rejects.toThrow(
      /not found/i,
    );
  });

  it("rename updates the name; cross-tenant rename 404s", async () => {
    const saved = await service.save(ownerId, {
      name: "Before",
      plan: makePlan(cacheIds, park),
    });
    const renamed = await service.rename(ownerId, saved.id, "After");
    expect(renamed.name).toBe("After");
    expect((await service.getById(ownerId, saved.id)).name).toBe("After");

    await expect(service.rename(otherId, saved.id, "Hijack")).rejects.toThrow(
      /not found/i,
    );
    expect((await service.getById(ownerId, saved.id)).name).toBe("After");
  });

  it("delete removes the row; cross-tenant delete 404s and leaves it intact", async () => {
    const saved = await service.save(ownerId, {
      name: "Doomed",
      plan: makePlan(cacheIds, park),
    });

    await expect(service.delete(otherId, saved.id)).rejects.toThrow(
      /not found/i,
    );
    // Still there for the owner.
    expect((await service.getById(ownerId, saved.id)).id).toBe(saved.id);

    await service.delete(ownerId, saved.id);
    await expect(service.getById(ownerId, saved.id)).rejects.toThrow(
      /not found/i,
    );
  });

  it("map snapshot round-trips, flips hasPreview, and is owner-scoped (FR-W4)", async () => {
    const saved = await service.save(ownerId, {
      name: "Snapshotted",
      plan: makePlan(cacheIds, park),
    });
    // Fresh save has no snapshot yet.
    expect(saved.hasPreview).toBe(false);
    expect((await service.list(ownerId))[0]!.hasPreview).toBe(false);

    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02]);
    await service.savePreview(ownerId, saved.id, bytes, "image/webp");

    // hasPreview now true on both detail and the lean summary.
    expect((await service.getById(ownerId, saved.id)).hasPreview).toBe(true);
    const summary = (await service.list(ownerId)).find(
      (t) => t.id === saved.id,
    );
    expect(summary?.hasPreview).toBe(true);

    // Bytes + mime read back verbatim.
    const preview = await service.getPreview(ownerId, saved.id);
    expect(preview.mime).toBe("image/webp");
    expect(Buffer.compare(preview.image, bytes)).toBe(0);

    // Cross-tenant store and read both 404.
    await expect(
      service.savePreview(otherId, saved.id, bytes, "image/webp"),
    ).rejects.toThrow(/not found/i);
    await expect(service.getPreview(otherId, saved.id)).rejects.toThrow(
      /not found/i,
    );
  });

  it("getPreview 404s when no snapshot has been captured (FR-W4)", async () => {
    const saved = await service.save(ownerId, {
      name: "No snapshot",
      plan: makePlan(cacheIds, park),
    });
    await expect(service.getPreview(ownerId, saved.id)).rejects.toThrow(
      /not found/i,
    );
  });

  it("snapshot omits caches the owner no longer has (FR-P1.3)", async () => {
    // A tour referencing an id the owner doesn't own → that id is absent from
    // the baked snapshot rather than breaking the save.
    const detail = await service.save(ownerId, {
      name: "Partial",
      plan: makePlan([...cacheIds, 9_999_999], park),
    });
    expect(detail.plan.caches).toHaveLength(2);
    // orderedCacheIds still records the missing id verbatim.
    expect(detail.plan.orderedCacheIds).toContain(9_999_999);
  });
});
