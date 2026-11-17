// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { RouteProfiles } from "@gctp/shared";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LanduseProfilesRepository } from "../../src/landuse-profiles/landuse-profiles.repository.js";
import { RouteProfilesRepository } from "../../src/route-profiles/route-profiles.repository.js";
import { RouteProfilesService } from "../../src/route-profiles/route-profiles.service.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

const FOREST_PRESET = "a0000000-0000-4000-8000-000000000002";
const FOREST_LANDUSE = "11111111-1111-1111-1111-111111111111";

function input(
  name: string,
  settings: RouteProfiles.RouteProfileSettingsInput = {},
): RouteProfiles.SaveRouteProfileInput {
  return RouteProfiles.SaveRouteProfileInput.parse({ name, settings });
}

describe("route profiles (FR-T19, PostGIS via Testcontainers)", () => {
  let pg: PostgresFixture;
  let service: RouteProfilesService;
  let ownerId: string;
  let otherId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    const owner = await pg.db
      .insertInto("users")
      .values({ email: "rp@gctp.local", display_name: "RP Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = owner.id;
    const other = await pg.db
      .insertInto("users")
      .values({ email: "rp-other@gctp.local", display_name: "Other" })
      .returning("id")
      .executeTakeFirstOrThrow();
    otherId = other.id;
    service = new RouteProfilesService(
      new RouteProfilesRepository(pg.db),
      new LanduseProfilesRepository(pg.db),
    );
  }, 120_000);

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("lists the seeded presets, fully parsed, before any own profile", async () => {
    const own = await service.create(ownerId, input("Zzz mine"));
    const list = await service.list(ownerId);
    expect(list.slice(0, 3).map((p) => p.name)).toEqual([
      "Adventure Lab day",
      "Forest walk",
      "Quick traditionals",
    ]);
    expect(list.slice(0, 3).every((p) => p.ownerId === null)).toBe(true);
    expect(list.at(-1)?.id).toBe(own.id);

    const forest = list.find((p) => p.id === FOREST_PRESET)!;
    // Stored sparse; defaults fill the rest on read.
    expect(forest.settings.objective.landuseProfileId).toBe(FOREST_LANDUSE);
    expect(forest.settings.budget).toEqual({
      distanceBudgetMeters: 8000,
      durationMinutes: 180,
      bufferMinutes: 10,
    });
    expect(forest.settings.time.visitMinutes).toBe(5);
    await service.delete(ownerId, own.id);
  });

  it("creates, updates and deletes the caller's own profile", async () => {
    const created = await service.create(
      ownerId,
      input("After work", { time: { visitMinutes: 4 } }),
    );
    expect(created.ownerId).toBe(ownerId);
    expect(created.settings.time.visitMinutes).toBe(4);

    const updated = await service.update(
      ownerId,
      created.id,
      input("After work (short)", { budget: { distanceBudgetMeters: 4000 } }),
    );
    expect(updated.name).toBe("After work (short)");
    expect(updated.settings.budget.distanceBudgetMeters).toBe(4000);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
      created.updatedAt.getTime(),
    );

    await service.delete(ownerId, created.id);
    expect((await service.list(ownerId)).some((p) => p.id === created.id)).toBe(
      false,
    );
  });

  it("isolates profiles per user (another user's id is not found)", async () => {
    const mine = await service.create(ownerId, input("Private"));
    expect((await service.list(otherId)).some((p) => p.id === mine.id)).toBe(
      false,
    );
    await expect(
      service.update(otherId, mine.id, input("Hijacked")),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.delete(otherId, mine.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await service.delete(ownerId, mine.id);
  });

  it("keeps system presets read-only", async () => {
    await expect(
      service.update(ownerId, FOREST_PRESET, input("Mine now")),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.delete(ownerId, FOREST_PRESET)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects a duplicate name per owner, case-insensitively", async () => {
    const first = await service.create(ownerId, input("Weekend"));
    await expect(
      service.create(ownerId, input("weekend")),
    ).rejects.toBeInstanceOf(ConflictException);
    // Another user may use the same name, and so may anyone reuse a preset's.
    const theirs = await service.create(otherId, input("Weekend"));
    const presetName = await service.create(ownerId, input("Forest walk"));
    await service.delete(ownerId, first.id);
    await service.delete(otherId, theirs.id);
    await service.delete(ownerId, presetName.id);
  });

  it("rejects a landuse profile the caller can't see", async () => {
    await expect(
      service.create(
        ownerId,
        input("Bad landuse", {
          objective: {
            landuseProfileId: "99999999-9999-4999-8999-999999999999",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
