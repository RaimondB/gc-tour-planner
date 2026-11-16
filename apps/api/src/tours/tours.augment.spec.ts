// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import type { Caches, Routing } from "@gctp/shared";
import type { CachesRepository } from "../caches/caches.repository.js";
import type { RoutingService } from "../routing/routing.service.js";
import type { AdventureLabEnricher } from "../sources/adventure-lab/al-enricher.service.js";
import { ToursService } from "./tours.service.js";

/** Minimal CacheDTO-ish stub — only the fields augment reads. */
function cache(
  id: number,
  lng: number,
  lat: number,
  adventureId: string | null = null,
): Caches.CacheDTO {
  return {
    id,
    adventureId,
    location: { type: "Point", coordinates: [lng, lat] },
  } as unknown as Caches.CacheDTO;
}

/** Fully-connected (100 m) walking matrix, minus any stranded ids. */
function makeMatrix(
  ids: readonly number[],
  unreachable: ReadonlySet<number>,
): Routing.Matrix {
  const list = [...ids];
  return {
    profile: "foot",
    cacheIds: list,
    legs: list.map((a) =>
      list.map((b) =>
        a === b
          ? { meters: 0, seconds: 0 }
          : unreachable.has(a) || unreachable.has(b)
            ? null
            : { meters: 100, seconds: 100 },
      ),
    ),
  };
}

/** Build a ToursService with only the collaborators augment touches stubbed. */
function makeService(opts: {
  enabled: boolean;
  clusterRows: Caches.CacheDTO[];
  nearbyLabs: Caches.CacheDTO[];
  unreachableIds?: number[];
}) {
  const enrich = vi.fn().mockResolvedValue({ importedCaches: 0 });
  const adventureLab = {
    get enabled() {
      return opts.enabled;
    },
    enrich,
  } as unknown as AdventureLabEnricher;
  const cachesRepo = {
    findByIds: vi.fn().mockResolvedValue(opts.clusterRows),
    find: vi.fn().mockResolvedValue(opts.nearbyLabs),
  } as unknown as CachesRepository;
  const unreachable = new Set(opts.unreachableIds ?? []);
  const routing = {
    getMatrix: vi
      .fn()
      .mockImplementation(async (_ownerId: string, ids: number[]) =>
        makeMatrix(ids, unreachable),
      ),
  } as unknown as RoutingService;

  const svc = new ToursService(
    null as never, // planner (TOUR_PLANNER)
    null as never, // greedy
    null as never, // solver
    null as never, // config
    null as never, // caches (CachesService)
    cachesRepo,
    null as never, // cacheLanduse
    routing,
    null as never, // routingRepo
    null as never, // osrm
    null as never, // osrmVersion
    adventureLab,
    null as never, // places (PlacesRepository) — unused by augment paths
  );
  return { svc, enrich };
}

const AUGMENT_INPUT = { cacheIds: [1, 2], maxLinkMeters: 1500 };

describe("ToursService.augmentClusterWithLabs", () => {
  it("returns the input unchanged when the admin flag is off", async () => {
    const { svc, enrich } = makeService({
      enabled: false,
      clusterRows: [],
      nearbyLabs: [],
    });
    const res = await svc.augmentClusterWithLabs("o1", AUGMENT_INPUT);
    expect(res).toEqual({ cacheIds: [1, 2], added: 0, skipped: 0 });
    expect(enrich).not.toHaveBeenCalled();
  });

  it("adds nearby labs nearest-first, dropping ones already in the cluster", async () => {
    // Cluster of two caches around (5.00, 52.00); centroid ~ (5.0005, 52.0).
    const clusterRows = [cache(1, 5.0, 52.0), cache(2, 5.001, 52.0)];
    // Nearby labs: 10 is already in the cluster (must be excluded), 11 is far,
    // 12 is near. Expect near (12) before far (11).
    const nearbyLabs = [
      cache(10, 5.0005, 52.0), // dup of an existing id
      cache(11, 5.02, 52.0), // far
      cache(12, 5.0009, 52.0), // near
    ];
    // Make id 10 collide with a cluster id by reusing id 1.
    nearbyLabs[0]!.id = 1;
    const { svc, enrich } = makeService({
      enabled: true,
      clusterRows,
      nearbyLabs,
    });

    const res = await svc.augmentClusterWithLabs("o1", AUGMENT_INPUT);

    expect(enrich).toHaveBeenCalledOnce();
    // Originals kept; only fresh labs appended, nearest (12) before far (11).
    expect(res.cacheIds).toEqual([1, 2, 12, 11]);
    expect(res.added).toBe(2);
    expect(res.skipped).toBe(0);
  });

  it("skips a nearby lab that doesn't connect to the cluster's walking graph", async () => {
    const clusterRows = [cache(1, 5.0, 52.0), cache(2, 5.001, 52.0)];
    // 12 connects (cohesive); 11 is straight-line near-ish but across a barrier
    // (no walking route) → must be skipped, not added.
    const nearbyLabs = [cache(11, 5.005, 52.0), cache(12, 5.0009, 52.0)];
    const { svc } = makeService({
      enabled: true,
      clusterRows,
      nearbyLabs,
      unreachableIds: [11],
    });

    const res = await svc.augmentClusterWithLabs("o1", AUGMENT_INPUT);

    expect(res.cacheIds).toEqual([1, 2, 12]);
    expect(res.added).toBe(1);
    expect(res.skipped).toBe(1);
  });
});
