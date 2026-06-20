// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pins `CachesRepository.findAdventureStages` (FR-I16) — the "pull in an
// adventure's missing stages" query that lets the solver keep Adventure Labs
// complete. Contract: every non-archived stage of the requested adventures,
// owner-scoped, resolved to full DTOs. Real PostGIS, no mocks (per CLAUDE.md).

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

describe("CachesRepository.findAdventureStages (FR-I16)", () => {
  let pg: PostgresFixture;
  let repo: CachesRepository;
  let ownerId: string;
  let otherOwnerId: string;

  async function seedStage(opts: {
    owner: string;
    code: string;
    adventureId: string | null;
    stageSequence: number | null;
    archived?: boolean;
    lng?: number;
    lat?: number;
  }): Promise<number> {
    const lng = opts.lng ?? 5.0;
    const lat = opts.lat ?? 52.0;
    const row = await pg.db
      .insertInto("caches")
      .values({
        owner_id: opts.owner,
        source: "gpx",
        source_id: opts.code,
        code: opts.code,
        type: "Adventure Lab",
        name: opts.code,
        location: sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
        published_location: sql<string>`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
        solved: false,
        archived: opts.archived ?? false,
        adventure_id: opts.adventureId,
        stage_sequence: opts.stageSequence,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return Number(row.id);
  }

  beforeAll(async () => {
    pg = await startPostgres();
    repo = new CachesRepository(pg.db);
    const u1 = await pg.db
      .insertInto("users")
      .values({ email: "al-owner@gctp.local", display_name: "AL Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = u1.id;
    const u2 = await pg.db
      .insertInto("users")
      .values({ email: "al-other@gctp.local", display_name: "AL Other" })
      .returning("id")
      .executeTakeFirstOrThrow();
    otherOwnerId = u2.id;
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("returns all non-archived stages of the requested adventures, owner-scoped", async () => {
    // Adventure A: 3 stages (one archived). Adventure B: 1 stage. A plain cache
    // and a foreign-owner stage of A that must NOT leak.
    const a1 = await seedStage({
      owner: ownerId,
      code: "A-1",
      adventureId: "ADV-A",
      stageSequence: 1,
    });
    const a2 = await seedStage({
      owner: ownerId,
      code: "A-2",
      adventureId: "ADV-A",
      stageSequence: 2,
    });
    await seedStage({
      owner: ownerId,
      code: "A-3-archived",
      adventureId: "ADV-A",
      stageSequence: 3,
      archived: true,
    });
    const b1 = await seedStage({
      owner: ownerId,
      code: "B-1",
      adventureId: "ADV-B",
      stageSequence: 1,
    });
    await seedStage({
      owner: ownerId,
      code: "plain",
      adventureId: null,
      stageSequence: null,
    });
    await seedStage({
      owner: otherOwnerId,
      code: "A-foreign",
      adventureId: "ADV-A",
      stageSequence: 1,
    });

    const stages = await repo.findAdventureStages(ownerId, ["ADV-A", "ADV-B"]);
    const ids = stages.map((s) => s.id).sort((x, y) => x - y);

    // a1, a2, b1 — archived A-3 and the foreign-owner A stage are excluded.
    expect(ids).toEqual([a1, a2, b1].sort((x, y) => x - y));
    expect(
      stages.every(
        (s) => s.adventureId === "ADV-A" || s.adventureId === "ADV-B",
      ),
    ).toBe(true);
  });

  it("returns [] for an empty adventure-id list (no query)", async () => {
    expect(await repo.findAdventureStages(ownerId, [])).toEqual([]);
  });

  it("does not return another owner's stages", async () => {
    const stages = await repo.findAdventureStages(otherOwnerId, ["ADV-B"]);
    expect(stages).toEqual([]);
  });
});
