// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Routing } from "@gctp/shared";
import type { Job } from "bullmq";
import { CacheLanduseRepository } from "../../caches/cache-landuse.repository.js";
import { CachesRepository } from "../../caches/caches.repository.js";
import { PrecomputeStateRepository } from "../../precompute-state/precompute-state.repository.js";
import { OsrmVersionService } from "../../routing/osrm-version.service.js";
import { OSRM_CLIENT, type OsrmClient } from "../../routing/osrm.client.js";
import { RoutingRepository } from "../../routing/routing.repository.js";
import { QUEUE_WALKING_PRECOMPUTE } from "../../queues/queue.tokens.js";
import { AffectedSetRepository } from "./affected-set.repository.js";
import type {
  WalkingPrecomputeJobData,
  WalkingPrecomputeJobResult,
} from "./walking-precompute.types.js";

const PROFILE: Routing.RoutingProfile = "foot";

/**
 * Background warm of `route_legs` for newly-uploaded caches AND for existing
 * caches whose top-k haversine neighbourhood now includes one of the
 * newcomers (the "affected set"). Mirrors the request-time `buildWalkingGraph`
 * over-fetch (`k_candidates = max(K*3, K+5) = 36` by default) so the next
 * Pass-1 cluster discovery reads everything from cache.
 *
 * See docs/design/precompute.md for the algorithm; ADR-0007 for the why.
 */
@Processor(QUEUE_WALKING_PRECOMPUTE)
export class WalkingPrecomputeProcessor extends WorkerHost {
  private readonly logger = new Logger(WalkingPrecomputeProcessor.name);

  constructor(
    private readonly caches: CachesRepository,
    private readonly affected: AffectedSetRepository,
    private readonly routing: RoutingRepository,
    private readonly osrmVersion: OsrmVersionService,
    @Inject(OSRM_CLIENT) private readonly osrm: OsrmClient,
    private readonly state: PrecomputeStateRepository,
    private readonly config: ConfigService,
    private readonly cacheLanduse: CacheLanduseRepository,
  ) {
    super();
  }

  async process(
    job: Job<WalkingPrecomputeJobData, WalkingPrecomputeJobResult>,
  ): Promise<WalkingPrecomputeJobResult> {
    const startedAt = Date.now();
    const { ownerId, newCacheIds, reason } = job.data;

    if (newCacheIds.length === 0) {
      return {
        inScopeCount: 0,
        pairsFetched: 0,
        pairsAlreadyFresh: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    // Match Pass-1 discovery's hard cap (clustering/context.ts:82 sets
    // `radiusM: min(maxLinkMeters * 2, 4_000)`). At 3 000 m the precompute
    // undershot any user choice of `maxLinkMeters > 1500`, so cluster
    // discovery had to re-fetch the 3-4 km pairs from OSRM on every
    // request. 4 000 m covers every reasonable slider value at the cost
    // of a ~1.8× larger one-time precompute fanout.
    const radiusM = this.envInt("PLANNER_PRECOMPUTE_RADIUS_M", 4000);
    const kTarget = this.envInt("PLANNER_KNN_K", 12);
    const kCandidates = Math.max(kTarget * 3, kTarget + 5);
    const chunkOrigins = this.envInt("PRECOMPUTE_OSRM_CHUNK_ORIGINS", 100);

    // 1. Resolve scope.
    const affectedIds = await this.affected.findAffected(
      ownerId,
      newCacheIds,
      radiusM,
    );
    const inScope = Array.from(new Set([...newCacheIds, ...affectedIds]));
    this.logger.log(
      `walking-precompute (${reason}): owner=${ownerId} new=${newCacheIds.length} ` +
        `affected=${affectedIds.length} inScope=${inScope.length}`,
    );

    // 2. Mark in-scope as in_progress. A bulk UPSERT; if the job fails before
    //    step 7, the operator dashboard surfaces these as "in_progress" and a
    //    retrigger-stale picks them up. The osrm_version stays null until a
    //    successful fetch stamps it.
    await this.state.markBulk(inScope, "walking", "in_progress");

    try {
      // 3. Look up cache coordinates.
      const coordRows = await this.routing.coordsFor(ownerId, inScope);
      const coordsById = new Map(
        coordRows.map((c) => [c.id, [c.lng, c.lat] as [number, number]]),
      );

      // 4. PostGIS k-NN over-fetch — top kCandidates haversine neighbours per
      //    in-scope cache within radiusM. Mirrors buildWalkingGraph step 1.
      const candidatePairs = await this.caches.nearestNeighbors(
        ownerId,
        inScope,
        kCandidates,
        radiusM,
      );
      if (candidatePairs.length === 0) {
        await this.state.markBulk(
          inScope,
          "walking",
          "fresh",
          { osrmVersion: this.osrmVersion.getVersion() },
        );
        return {
          inScopeCount: inScope.length,
          pairsFetched: 0,
          pairsAlreadyFresh: 0,
          durationMs: Date.now() - startedAt,
        };
      }

      // 5. Filter pairs already cached at the current OSRM version. Idempotent
      //    re-runs become near-no-ops.
      const osrmVersion = this.osrmVersion.getVersion();
      const alreadyCached = await this.routing.findMatrixCells(
        candidatePairs,
        PROFILE,
        osrmVersion,
      );
      const cachedKey = (from: number, to: number) => `${from}:${to}`;
      // Both real cells AND noroute markers count as resolved — re-asking
      // OSRM about a known no-route pair is exactly what this job is
      // meant to avoid.
      const cachedSet = new Set(
        alreadyCached.map((c) => cachedKey(c.fromCacheId, c.toCacheId)),
      );
      const missing = candidatePairs.filter(
        (p) => !cachedSet.has(cachedKey(p.fromCacheId, p.toCacheId)),
      );

      // 6. Group missing pairs by origin; fan out OSRM /table calls in
      //    bounded chunks. One /table per origin matches the runtime path
      //    in buildWalkingGraph — keeping the precompute behaviour identical
      //    means we never produce cells the runtime would reject.
      const byOrigin = new Map<number, number[]>();
      for (const p of missing) {
        const list = byOrigin.get(p.fromCacheId);
        if (list) list.push(p.toCacheId);
        else byOrigin.set(p.fromCacheId, [p.toCacheId]);
      }
      const origins = Array.from(byOrigin.keys());
      const toPersist: Array<{
        fromCacheId: number;
        toCacheId: number;
        profile: Routing.RoutingProfile;
        meters: number;
        seconds: number;
      }> = [];
      // Negative cache for pairs OSRM declines to route. Without
      // persisting these, every cluster discovery re-asks OSRM the
      // same questions and gets the same null answers — see
      // 1779640000000_route_legs_noroute migration for context.
      const toPersistNoRoute: Array<{
        fromCacheId: number;
        toCacheId: number;
        profile: Routing.RoutingProfile;
      }> = [];

      for (let i = 0; i < origins.length; i += chunkOrigins) {
        const batch = origins.slice(i, i + chunkOrigins);
        await Promise.all(
          batch.map(async (originId) => {
            const dests = byOrigin.get(originId)!;
            const originCoord = coordsById.get(originId);
            if (!originCoord) return;
            const destCoords = dests
              .map((id) => coordsById.get(id))
              .filter((c): c is [number, number] => c !== undefined);
            if (destCoords.length === 0) return;
            const matrix = await this.osrm.table(
              [originCoord, ...destCoords],
              PROFILE,
            );
            const row0 = matrix[0];
            if (!row0) return;
            for (let j = 0; j < dests.length; j += 1) {
              const cell = row0[j + 1]; // skip origin→origin diagonal
              if (!cell) {
                toPersistNoRoute.push({
                  fromCacheId: originId,
                  toCacheId: dests[j]!,
                  profile: PROFILE,
                });
                continue;
              }
              toPersist.push({
                fromCacheId: originId,
                toCacheId: dests[j]!,
                profile: PROFILE,
                meters: cell.meters,
                seconds: cell.seconds,
              });
            }
          }),
        );
      }

      if (toPersist.length > 0) {
        await this.routing.upsertMatrixCells(toPersist, osrmVersion);
      }
      if (toPersistNoRoute.length > 0) {
        await this.routing.upsertNorouteCells(toPersistNoRoute, osrmVersion);
      }

      // 7. Eagerly populate `cache_landuse` for the in-scope caches'
      //    bounding box. The function is idempotent (ON CONFLICT DO NOTHING)
      //    and PostGIS-fast (~50-100 ms). Pre-warming here saves that cost
      //    on the first plan after upload — symmetric with how this job
      //    pre-warms route_legs. Best-effort: a failure here does NOT fail
      //    the precompute job (route_legs is the load-bearing artifact;
      //    cache_landuse will be populated lazily by the planner if needed).
      const allCoords = inScope
        .map((id) => coordsById.get(id))
        .filter((c): c is [number, number] => c !== undefined);
      if (allCoords.length > 0) {
        const lngs = allCoords.map(([lng]) => lng);
        const lats = allCoords.map(([, lat]) => lat);
        // Add a tiny padding (~10 m at lat 52°) so caches sitting exactly
        // on a landuse boundary don't get missed by ST_Contains.
        const pad = 0.0001;
        const minLng = Math.min(...lngs) - pad;
        const minLat = Math.min(...lats) - pad;
        const maxLng = Math.max(...lngs) + pad;
        const maxLat = Math.max(...lats) + pad;
        try {
          const inserted = await this.cacheLanduse.populateForBbox(
            minLng,
            minLat,
            maxLng,
            maxLat,
          );
          if (inserted > 0) {
            this.logger.log(
              `walking-precompute (${reason}): warmed cache_landuse with ${inserted} new rows`,
            );
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `walking-precompute (${reason}): cache_landuse populate failed (lazy fallback will run on first plan): ${m}`,
          );
        }
      }

      // 8. Mark in-scope as fresh with the current OSRM version. Failed cells
      //    (impossible speeds / suspicious zero-distance) were silently
      //    dropped by upsertMatrixCells; that's not a per-cache failure, so
      //    the cache is still considered "fresh" — Pass 1 will just see
      //    fewer edges, exactly as today.
      await this.state.markBulk(inScope, "walking", "fresh", {
        osrmVersion,
      });

      const result: WalkingPrecomputeJobResult = {
        inScopeCount: inScope.length,
        pairsFetched: toPersist.length,
        pairsAlreadyFresh: alreadyCached.length,
        durationMs: Date.now() - startedAt,
      };
      this.logger.log(
        `walking-precompute (${reason}): done inScope=${result.inScopeCount} ` +
          `fetched=${result.pairsFetched} alreadyFresh=${result.pairsAlreadyFresh} ` +
          `${result.durationMs}ms`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `walking-precompute failed for owner=${ownerId}: ${message}`,
      );
      // Mark the in-scope set as failed so the operator dashboard surfaces
      // it and a retrigger-stale picks it up. We swallow + re-throw so
      // BullMQ also records the failure on the queue side (retries kick in
      // via the queue's exponential backoff).
      await this.state.markBulk(inScope, "walking", "failed", {
        errorText: message.slice(0, 500),
      });
      throw err;
    }
  }

  private envInt(name: string, fallback: number): number {
    const raw = this.config.get<string>(name);
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
}
