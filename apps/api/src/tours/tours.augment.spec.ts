// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import type { Caches } from "@gctp/shared";
import type { CachesRepository } from "../caches/caches.repository.js";
import type { AdventureLabEnricher } from "../sources/adventure-lab/al-enricher.service.js";
import { ToursService } from "./tours.service.js";

/** Minimal CacheDTO-ish stub — only the fields augment reads. */
function cache(id: number, lng: number, lat: number): Caches.CacheDTO {
  return {
    id,
    location: { type: "Point", coordinates: [lng, lat] },
  } as unknown as Caches.CacheDTO;
}

/** Build a ToursService with only the collaborators augment touches stubbed. */
function makeService(opts: {
  enabled: boolean;
  clusterRows: Caches.CacheDTO[];
  nearbyLabs: Caches.CacheDTO[];
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

  const svc = new ToursService(
    null as never, // planner
    null as never, // caches (CachesService)
    cachesRepo,
    null as never, // cacheLanduse
    null as never, // routing
    null as never, // routingRepo
    null as never, // osrm
    null as never, // osrmVersion
    adventureLab,
  );
  return { svc, enrich };
}

describe("ToursService.augmentClusterWithLabs", () => {
  it("returns the input unchanged when the admin flag is off", async () => {
    const { svc, enrich } = makeService({
      enabled: false,
      clusterRows: [],
      nearbyLabs: [],
    });
    const res = await svc.augmentClusterWithLabs("o1", { cacheIds: [1, 2] });
    expect(res).toEqual({ cacheIds: [1, 2], added: 0 });
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

    const res = await svc.augmentClusterWithLabs("o1", { cacheIds: [1, 2] });

    expect(enrich).toHaveBeenCalledOnce();
    // Originals kept; only fresh labs appended, nearest (12) before far (11).
    expect(res.cacheIds).toEqual([1, 2, 12, 11]);
    expect(res.added).toBe(2);
  });
});
