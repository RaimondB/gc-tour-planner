// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pins the Adventure Lab walking-edge guarantee: the walking-precompute job
// must produce the FULL pairwise stage→stage matrix for a touched adventure —
// not just each stage's k-nearest neighbours — so no AL stage is ever isolated
// in the walking graph (atomic-adventure solver routing needs every pair). Also
// covers the route_legs-based repair detector and the relocation re-warm.
//
// To isolate the full-pairwise contribution from the k-NN over-fetch, the
// adventure's stages are spaced ~10 km apart — well beyond the precompute's
// 4 km radius — so `nearestNeighbors` links NONE of them. Any intra-adventure
// leg that lands in `route_legs` therefore came from the unconditional
// full-pairwise step. Real PostGIS + a deterministic in-memory OSRM, no DB
// mocks (per CLAUDE.md).

import type { ConfigService } from "@nestjs/config";
import type { Job } from "bullmq";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CachesRepository } from "../../src/caches/caches.repository.js";
import { CacheLanduseRepository } from "../../src/caches/cache-landuse.repository.js";
import { AffectedSetRepository } from "../../src/jobs/walking-precompute/affected-set.repository.js";
import { WalkingPrecomputeProcessor } from "../../src/jobs/walking-precompute/walking-precompute.processor.js";
import type {
  WalkingPrecomputeJobData,
  WalkingPrecomputeJobResult,
} from "../../src/jobs/walking-precompute/walking-precompute.types.js";
import { PrecomputeStateRepository } from "../../src/precompute-state/precompute-state.repository.js";
import { OsrmVersionService } from "../../src/routing/osrm-version.service.js";
import type { OsrmClient } from "../../src/routing/osrm.client.js";
import { RoutingRepository } from "../../src/routing/routing.repository.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

/** Equirectangular metres — enough to feed deterministic, sanity-passing legs. */
function metresBetween(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const meanLat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dLat = (b[1] - a[1]) * (Math.PI / 180);
  const dLng = (b[0] - a[0]) * (Math.PI / 180) * Math.cos(meanLat);
  return Math.round(Math.hypot(dLat, dLng) * R);
}

/**
 * In-memory OSRM stand-in: row 0 holds origin→dest distances at a walkable
 * ~5 km/h (so the repo's impossible-speed guard never drops a cell). Only
 * `table` is exercised by the precompute job.
 */
const fakeOsrm: OsrmClient = {
  table(coords) {
    const [origin, ...dests] = coords as [number, number][];
    const row0 = [
      { meters: 0, seconds: 0 },
      ...dests.map((d) => {
        const meters = metresBetween(origin!, d);
        return { meters, seconds: Math.round(meters / 1.4) };
      }),
    ];
    return Promise.resolve([row0]);
  },
} as unknown as OsrmClient;

const fakeConfig = { get: () => undefined } as unknown as ConfigService;

describe("Adventure Lab walking edges (full pairwise + repair)", () => {
  let pg: PostgresFixture;
  let ownerId: string;
  let processor: WalkingPrecomputeProcessor;
  let routing: RoutingRepository;
  const osrmVersion = new OsrmVersionService();

  async function seedStage(opts: {
    owner: string;
    code: string;
    adventureId: string | null;
    lng: number;
    lat: number;
    type?: string;
  }): Promise<number> {
    const row = await pg.db
      .insertInto("caches")
      .values({
        owner_id: opts.owner,
        source: "gpx",
        source_id: opts.code,
        code: opts.code,
        type: opts.type ?? "Adventure Lab",
        name: opts.code,
        location: sql<string>`ST_SetSRID(ST_MakePoint(${opts.lng}, ${opts.lat}), 4326)::geography`,
        published_location: sql<string>`ST_SetSRID(ST_MakePoint(${opts.lng}, ${opts.lat}), 4326)::geography`,
        solved: false,
        adventure_id: opts.adventureId,
        stage_sequence: opts.adventureId ? 1 : null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return Number(row.id);
  }

  /** Directed legs among `ids` that exist as real (non-noroute) route_legs. */
  async function pairwiseLegCount(ids: number[]): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n
        FROM route_legs
       WHERE profile = 'foot'
         AND source <> 'noroute'
         AND from_cache_id IN (${sql.join(ids)})
         AND to_cache_id IN (${sql.join(ids)})
    `.execute(pg.db);
    return Number(rows[0]!.n);
  }

  function runJob(newCacheIds: number[]): Promise<WalkingPrecomputeJobResult> {
    const job = {
      data: {
        ownerId,
        newCacheIds,
        reason: "upload",
      } satisfies WalkingPrecomputeJobData,
    } as unknown as Job<WalkingPrecomputeJobData, WalkingPrecomputeJobResult>;
    return processor.process(job);
  }

  beforeAll(async () => {
    pg = await startPostgres();
    routing = new RoutingRepository(pg.db);
    processor = new WalkingPrecomputeProcessor(
      new CachesRepository(pg.db),
      new AffectedSetRepository(pg.db),
      routing,
      osrmVersion,
      fakeOsrm,
      new PrecomputeStateRepository(pg.db),
      fakeConfig,
      new CacheLanduseRepository(pg.db),
    );
    const u = await pg.db
      .insertInto("users")
      .values({ email: "al-edges@gctp.local", display_name: "AL Edges" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = u.id;
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("precomputes the full pairwise matrix for a touched adventure, even when stages are out of k-NN radius", async () => {
    // 3 stages ~10 km apart in latitude (0.09° ≈ 10 km) → none within the 4 km
    // precompute radius of any other, so nearestNeighbors links zero pairs.
    const s1 = await seedStage({
      owner: ownerId,
      code: "FAR-1",
      adventureId: "ADV-FAR",
      lng: 5.0,
      lat: 52.0,
    });
    const s2 = await seedStage({
      owner: ownerId,
      code: "FAR-2",
      adventureId: "ADV-FAR",
      lng: 5.0,
      lat: 52.09,
    });
    const s3 = await seedStage({
      owner: ownerId,
      code: "FAR-3",
      adventureId: "ADV-FAR",
      lng: 5.0,
      lat: 52.18,
    });
    const stages = [s1, s2, s3];

    // Enqueue with just ONE stage as the newcomer — the job must pull in the
    // whole adventure and connect every pair.
    await runJob([s1]);

    // 3 stages → 3×2 = 6 directed legs, all present.
    expect(await pairwiseLegCount(stages)).toBe(6);
    // The adventure is now fully pairwise → none of its stages are flagged for
    // repair.
    const flagged = await routing.adventureLabStageIdsWithIncompletePairwise(
      osrmVersion.getVersion(),
      100,
    );
    for (const id of stages) expect(flagged).not.toContain(id);
  });

  it("restores a relocated stage's sibling legs on the re-warm", async () => {
    // Simulate the upsert's relocation invalidation: drop every leg touching s2
    // (both directions), as gpx.repository does when a cache moves > 1 m.
    const s2 = (
      await pg.db
        .selectFrom("caches")
        .select("id")
        .where("owner_id", "=", ownerId)
        .where("code", "=", "FAR-2")
        .executeTakeFirstOrThrow()
    ).id;
    await pg.db
      .deleteFrom("route_legs")
      .where((eb) =>
        eb.or([
          eb("from_cache_id", "=", Number(s2)),
          eb("to_cache_id", "=", Number(s2)),
        ]),
      )
      .execute();

    const stages = (
      await pg.db
        .selectFrom("caches")
        .select("id")
        .where("owner_id", "=", ownerId)
        .where("adventure_id", "=", "ADV-FAR")
        .execute()
    ).map((r) => Number(r.id));
    expect(await pairwiseLegCount(stages)).toBe(2); // only s1↔s3 survive

    // Re-warm with the moved stage → full pairwise back.
    await runJob([Number(s2)]);
    expect(await pairwiseLegCount(stages)).toBe(6);
  });

  it("adventureLabStageIdsWithIncompletePairwise flags multi-stage adventures missing a sibling pair", async () => {
    const version = osrmVersion.getVersion();
    // A 2-stage adventure: full pairwise needs 2 directed legs (a→b, b→a).
    const a = await seedStage({
      owner: ownerId,
      code: "PAIR-A",
      adventureId: "ADV-PAIR",
      lng: 4.0,
      lat: 51.0,
    });
    const b = await seedStage({
      owner: ownerId,
      code: "PAIR-B",
      adventureId: "ADV-PAIR",
      lng: 4.001,
      lat: 51.0,
    });
    // A single-stage adventure (k=1, expected 0 pairs) must never be flagged.
    const lonely = await seedStage({
      owner: ownerId,
      code: "SOLO-1",
      adventureId: "ADV-SOLO",
      lng: 4.0,
      lat: 51.0,
    });

    const insertLeg = (from: number, to: number) =>
      pg.db
        .insertInto("route_legs")
        .values({
          from_cache_id: from,
          to_cache_id: to,
          profile: "foot",
          meters: 70,
          seconds: 50,
          source: "table",
          osrm_version: version,
          geom: null,
        })
        .execute();

    // Only one of the two directed legs present → incomplete.
    await insertLeg(a, b);
    let flagged = await routing.adventureLabStageIdsWithIncompletePairwise(
      version,
      500,
    );
    expect(flagged).toEqual(expect.arrayContaining([a, b]));
    expect(flagged).not.toContain(lonely);

    // Add the reverse leg → adventure is fully pairwise → no longer flagged.
    await insertLeg(b, a);
    flagged = await routing.adventureLabStageIdsWithIncompletePairwise(
      version,
      500,
    );
    expect(flagged).not.toContain(a);
    expect(flagged).not.toContain(b);

    // A `noroute` row counts as covered (OSRM already asked) — so an adventure
    // whose only "missing" pair is a known no-route is NOT re-flagged.
    const c = await seedStage({
      owner: ownerId,
      code: "NR-A",
      adventureId: "ADV-NR",
      lng: 4.2,
      lat: 51.2,
    });
    const d = await seedStage({
      owner: ownerId,
      code: "NR-B",
      adventureId: "ADV-NR",
      lng: 4.201,
      lat: 51.2,
    });
    await insertLeg(c, d);
    await pg.db
      .insertInto("route_legs")
      .values({
        from_cache_id: d,
        to_cache_id: c,
        profile: "foot",
        meters: null,
        seconds: null,
        source: "noroute",
        osrm_version: version,
        geom: null,
      })
      .execute();
    flagged = await routing.adventureLabStageIdsWithIncompletePairwise(
      version,
      500,
    );
    expect(flagged).not.toContain(c);
    expect(flagged).not.toContain(d);
  });
});
