// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Geo, RouteProfiles, Walks } from "@gctp/shared";
import { NotFoundException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import { CachesService } from "../../src/caches/caches.service.js";
import { CacheLanduseRepository } from "../../src/caches/cache-landuse.repository.js";
import { LanduseProfilesRepository } from "../../src/landuse-profiles/landuse-profiles.repository.js";
import type {
  OsrmClient,
  OsrmLeg,
  OsrmMatrixEntry,
  TableOptions,
} from "../../src/routing/osrm.client.js";
import { RoutingRepository } from "../../src/routing/routing.repository.js";
import { RoutingService } from "../../src/routing/routing.service.js";
import { SavedToursRepository } from "../../src/tours/saved-tours.repository.js";
import { WalksService } from "../../src/walks/walks.service.js";
import {
  fakeComputePool,
  fakeWalkingQueue,
  makeOsrmVersion,
} from "./integration-helpers.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

/** Walking = straight line × 1.3; honours table sources/destinations. */
class FakeOsrm implements OsrmClient {
  private leg(a: [number, number], b: [number, number]): OsrmLeg {
    const meters = Geo.haversineMeters(a, b) * 1.3;
    return {
      meters,
      seconds: meters / 1.4,
      geometry: { type: "LineString", coordinates: [a, b] },
    };
  }
  async route(a: [number, number], b: [number, number]) {
    return this.leg(a, b);
  }
  async routeAlternatives(a: [number, number], b: [number, number]) {
    return [this.leg(a, b)];
  }
  async routeMulti(coords: readonly [number, number][]) {
    let meters = 0;
    for (let i = 1; i < coords.length; i += 1)
      meters += this.leg(coords[i - 1]!, coords[i]!).meters;
    return {
      meters,
      seconds: meters / 1.4,
      geometry: { type: "LineString" as const, coordinates: [...coords] },
    };
  }
  async table(
    coords: readonly [number, number][],
    _profile: string,
    opts: TableOptions = {},
  ): Promise<(OsrmMatrixEntry | null)[][]> {
    const rows = opts.sources ?? coords.map((_, i) => i);
    const cols = opts.destinations ?? coords.map((_, i) => i);
    return rows.map((i) =>
      cols.map((j) => {
        const l = this.leg(coords[i]!, coords[j]!);
        return { meters: l.meters, seconds: l.seconds };
      }),
    );
  }
  async nearest(p: [number, number]) {
    return p;
  }
}

const HOME: [number, number] = [5.12, 52.09];
const T0 = "2026-11-17T10:00:00.000Z";
const at = (minutes: number) =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();

describe("ad-hoc walk replan (ADR-0040, PostGIS via Testcontainers)", () => {
  let pg: PostgresFixture;
  let service: WalksService;
  let ownerId: string;
  let otherCacheId: number;
  let farId: number;
  let multiId: number;
  const nearIds: number[] = [];

  async function insertCache(
    owner: string,
    code: string,
    lng: number,
    lat: number,
    type = "Traditional",
  ): Promise<number> {
    const row = await pg.db
      .insertInto("caches")
      .values({
        owner_id: owner,
        source: "gpx",
        source_id: code,
        code,
        type,
        name: code,
        location: sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
        raw: { test: true },
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return Number(row.id);
  }

  beforeAll(async () => {
    pg = await startPostgres();
    const owner = await pg.db
      .insertInto("users")
      .values({ email: "walk@gctp.local", display_name: "Walker" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = owner.id;
    const other = await pg.db
      .insertInto("users")
      .values({ email: "walk-other@gctp.local", display_name: "Other" })
      .returning("id")
      .executeTakeFirstOrThrow();

    // A ring of caches 300–600 m around home, a Multi, one far away.
    const ring: [number, number][] = [
      [0.004, 0],
      [0.006, 0.002],
      [0.004, 0.004],
      [0, 0.004],
      [-0.004, 0.003],
      [-0.005, 0],
    ];
    for (const [i, [dx, dy]] of ring.entries()) {
      nearIds.push(
        await insertCache(ownerId, `GCWALK${i}`, HOME[0] + dx, HOME[1] + dy),
      );
    }
    multiId = await insertCache(ownerId, "GCWALKM", 5.12, 52.087, "Multi");
    farId = await insertCache(ownerId, "GCWALKFAR", 5.3, 52.2);
    otherCacheId = await insertCache(other.id, "GCNOTMINE", 5.121, 52.091);

    const routingRepo = new RoutingRepository(pg.db);
    const osrm = new FakeOsrm();
    service = new WalksService(
      new CachesService(new CachesRepository(pg.db), fakeWalkingQueue()),
      new CacheLanduseRepository(pg.db),
      new LanduseProfilesRepository(pg.db),
      new SavedToursRepository(pg.db),
      new RoutingService(routingRepo, osrm, makeOsrmVersion()),
      osrm,
      fakeComputePool(),
      { get: () => undefined } as unknown as ConfigService,
    );
  }, 120_000);

  afterAll(async () => {
    await stopPostgres(pg);
  });

  const replan = (
    minutes: number,
    extra: Partial<Walks.WalkReplanInput> & {
      profile?: RouteProfiles.RouteProfileSettingsInput;
    } = {},
  ) =>
    service.replan(
      ownerId,
      Walks.WalkReplanInput.parse({
        position: HOME,
        returnPoint: HOME,
        now: T0,
        deadline: at(minutes),
        ...extra,
        profile: RouteProfiles.RouteProfileSettings.parse(extra.profile ?? {}),
      }),
    );

  it("plans a feasible loop back home before deadline − buffer", async () => {
    const res = await replan(90);
    expect(res.feasible).toBe(true);
    expect(res.order.length).toBeGreaterThan(2);
    expect(res.order.map((s) => s.cacheId)).not.toContain(farId);
    expect(res.order.map((s) => s.cacheId)).not.toContain(otherCacheId);
    // Back by 11:20 (90 min deadline − 10 min buffer).
    expect(Date.parse(res.returnAt)).toBeLessThanOrEqual(Date.parse(at(80)));
    expect(res.slackMinutes).toBeGreaterThanOrEqual(0);
    expect(res.geometry?.coordinates[0]).toEqual(HOME);
    expect(res.kept).toBe("new");
  });

  it("fits fewer caches in less time, none when there's no time", async () => {
    const long = await replan(90);
    const short = await replan(35);
    expect(short.order.length).toBeLessThan(long.order.length);
    const none = await replan(8); // 8 min deadline, 10 min buffer
    expect(none.feasible).toBe(false);
    expect(none.order).toEqual([]);
    expect(none.reason).toMatch(/No time for caches/);
  });

  it("leaves out caches already visited, skipped or DNF on this walk", async () => {
    const res = await replan(90, {
      visitedIds: [nearIds[0]!],
      skippedIds: [nearIds[1]!],
      dnfIds: [nearIds[2]!],
    });
    const ids = res.order.map((s) => s.cacheId);
    for (const id of nearIds.slice(0, 3)) expect(ids).not.toContain(id);
  });

  it("applies the profile's filters", async () => {
    const res = await replan(90, {
      profile: { filters: { types: ["Multi"] } },
    });
    expect(res.order.map((s) => s.cacheId)).toEqual([multiId]);
  });

  it("keeps the previous route unless the new one is clearly better", async () => {
    const first = await replan(90);
    const again = await replan(90, {
      previousOrder: first.order.map((s) => s.cacheId),
    });
    expect(again.kept).toBe("previous");
    expect(again.order).toEqual(first.order);

    const meagre = await replan(90, { previousOrder: [nearIds[3]!] });
    expect(meagre.kept).toBe("new");
    expect(meagre.order.length).toBeGreaterThan(1);
  });

  it("always goes to a locked next cache first", async () => {
    const res = await replan(90, { lockedNextId: nearIds[4]! });
    expect(res.feasible).toBe(true);
    expect(res.order[0]!.cacheId).toBe(nearIds[4]);
  });

  it("reports how late an infeasible locked cache makes you", async () => {
    const res = await replan(90, { lockedNextId: farId });
    expect(res.feasible).toBe(false);
    expect(res.order.map((s) => s.cacheId)).toEqual([farId]);
    expect(res.lateByMinutes).toBeGreaterThan(0);
  });

  it("refuses to lock someone else's cache", async () => {
    await expect(
      replan(90, { lockedNextId: otherCacheId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
