// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Database } from "@gctp/db";
import type { Admin } from "@gctp/shared";
import type { Queue } from "bullmq";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../../database/database.tokens.js";
import { PrecomputeStateRepository } from "../../precompute-state/precompute-state.repository.js";
import { QUEUE_WALKING_PRECOMPUTE } from "../../queues/queue.tokens.js";
import { OsrmVersionService } from "../../routing/osrm-version.service.js";
import type { WalkingPrecomputeJobData } from "../../jobs/walking-precompute/walking-precompute.types.js";

/** Default TTL beyond which a 'fresh' row is considered stale. */
const DEFAULT_STALE_TTL_DAYS = 30;
/** Default cache count per retrigger job (bounds individual job runtime). */
const DEFAULT_RETRIGGER_CHUNK = 50;
/** Hard cap on how many stale caches one retrigger call can enqueue. */
const RETRIGGER_HARD_MAX = 10_000;

@Injectable()
export class AdminPrecomputeService {
  private readonly logger = new Logger(AdminPrecomputeService.name);

  constructor(
    private readonly state: PrecomputeStateRepository,
    private readonly osrmVersion: OsrmVersionService,
    private readonly config: ConfigService,
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    @InjectQueue(QUEUE_WALKING_PRECOMPUTE)
    private readonly walkingQueue: Queue<WalkingPrecomputeJobData>,
  ) {}

  async summary(): Promise<Admin.PrecomputeSummary> {
    const osrmVersion = this.osrmVersion.getVersion();
    const counts = await this.state.summary({
      currentOsrmVersion: osrmVersion,
      staleTtlDays: this.staleTtlDays(),
    });
    return {
      walking: counts.walking,
      osrmVersion,
    };
  }

  async listStale(
    kind: Admin.PrecomputeKind,
    limit: number,
    offset: number,
  ): Promise<Admin.StaleCacheListResponse> {
    const { entries, total } = await this.state.listStale({
      kind,
      currentOsrmVersion: this.osrmVersion.getVersion(),
      staleTtlDays: this.staleTtlDays(),
      limit,
      offset,
    });
    return {
      total,
      // The DB enum still has 'landuse' for back-compat with old rows;
      // the migration deletes them all but the type system can't know
      // that. We filter defensively here so the wire-format never carries
      // a kind the admin schema doesn't allow.
      entries: entries
        .filter(
          (e): e is typeof e & { kind: "walking" } => e.kind === "walking",
        )
        .map((e) => ({
          cacheId: e.cacheId,
          kind: e.kind,
          state: e.state,
          fetchedAt: e.fetchedAt ? e.fetchedAt.toISOString() : null,
          osrmVersion: e.osrmVersion,
          errorText: e.errorText,
        })),
    };
  }

  /**
   * Find all stale caches for the requested kind(s) and enqueue retrigger
   * jobs in chunks. Owner inference: stale-precompute rows DON'T carry an
   * owner_id (the table is keyed on cache_id, and the cache itself owns
   * the link via FK). The processors filter their own queries by ownerId,
   * so we need to join to caches to recover that. Today the dev-user
   * middleware leaves us single-tenant — we pull every owner's stale
   * caches in one bucket. When M6 auth lands, this method becomes
   * caller-scoped.
   */
  async retriggerStale(
    kind: Admin.RetriggerStaleRequest["kind"],
  ): Promise<Admin.RetriggerStaleResponse> {
    // ADR-0009: landuse no longer has per-cache precompute state. 'walking'
    // is the only kind. 'all' is kept on the wire for forward compat.
    const kinds: Admin.PrecomputeKind[] = ["walking"];
    void kind;
    const chunkSize = this.envInt(
      "PRECOMPUTE_RETRIGGER_CHUNK",
      DEFAULT_RETRIGGER_CHUNK,
    );

    const jobIds: string[] = [];
    let totalEnqueued = 0;

    for (const k of kinds) {
      const staleCacheIds = await this.state.staleCacheIds({
        kind: k,
        currentOsrmVersion: this.osrmVersion.getVersion(),
        staleTtlDays: this.staleTtlDays(),
        limit: RETRIGGER_HARD_MAX,
      });
      if (staleCacheIds.length === 0) continue;

      // Group stale caches by owner so each job carries a single ownerId.
      // The processors all run owner-scoped queries; mixing owners in one
      // payload would let one owner's caches leak into another's precompute
      // scope when M6 auth lands.
      const idsByOwner = await this.groupByOwner(staleCacheIds);

      for (const [ownerId, ids] of idsByOwner) {
        for (let i = 0; i < ids.length; i += chunkSize) {
          const slice = ids.slice(i, i + chunkSize);
          const job = await this.enqueue(k, ownerId, slice, "retrigger-stale");
          jobIds.push(job);
          totalEnqueued += slice.length;
        }
      }
    }

    this.logger.log(
      `retrigger-stale: kind=${kind} enqueued=${totalEnqueued} jobs=${jobIds.length}`,
    );
    return { enqueued: totalEnqueued, jobIds };
  }

  async retriggerOne(
    cacheId: number,
    kind: Admin.PrecomputeKind,
  ): Promise<{ jobId: string }> {
    const owner = await this.groupByOwner([cacheId]);
    const [ownerId, ids] = owner.entries().next().value ?? [null, []];
    if (!ownerId || ids.length === 0) {
      throw new Error(
        `Cache ${cacheId} not found (deleted? wrong owner?). Cannot retrigger.`,
      );
    }
    const jobId = await this.enqueue(kind, ownerId, ids, "retrigger-one");
    return { jobId };
  }

  /**
   * FR-I20: walking-precompute health for Adventure Lab stages — the "check".
   * `missing` here means an AL stage with no `route_legs` yet (isolated in the
   * walking graph), which is why it can't cluster/plan until backfilled.
   */
  async adventureLabWalkingStatus(): Promise<Admin.AdventureLabWalkingStatus> {
    const osrmVersion = this.osrmVersion.getVersion();
    const { counts, total } = await this.state.adventureLabWalkingSummary({
      currentOsrmVersion: osrmVersion,
      staleTtlDays: this.staleTtlDays(),
    });
    return { counts, total, osrmVersion };
  }

  /**
   * FR-I20: enqueue walking precompute for every Adventure Lab stage whose legs
   * aren't fresh (missing / stale / failed / …). Scoped to ALs so it doesn't
   * re-warm the whole DB; grouped by owner + chunked like {@link retriggerStale}.
   */
  async backfillAdventureLabWalking(): Promise<Admin.RetriggerStaleResponse> {
    const chunkSize = this.envInt(
      "PRECOMPUTE_RETRIGGER_CHUNK",
      DEFAULT_RETRIGGER_CHUNK,
    );
    const ids = await this.state.adventureLabWalkingIdsNeedingPrecompute({
      currentOsrmVersion: this.osrmVersion.getVersion(),
      staleTtlDays: this.staleTtlDays(),
      limit: RETRIGGER_HARD_MAX,
    });
    const jobIds: string[] = [];
    let totalEnqueued = 0;
    if (ids.length > 0) {
      const idsByOwner = await this.groupByOwner(ids);
      for (const [ownerId, ownerIds] of idsByOwner) {
        for (let i = 0; i < ownerIds.length; i += chunkSize) {
          const slice = ownerIds.slice(i, i + chunkSize);
          const job = await this.enqueue(
            "walking",
            ownerId,
            slice,
            "retrigger-stale",
          );
          jobIds.push(job);
          totalEnqueued += slice.length;
        }
      }
    }
    this.logger.log(
      `backfill-adventure-labs-walking: enqueued=${totalEnqueued} jobs=${jobIds.length}`,
    );
    return { enqueued: totalEnqueued, jobIds };
  }

  /**
   * Resolve each cache_id to its owner_id. Returns a map ownerId →
   * cacheIds. Caches without an owner (public-source) are silently
   * dropped; the precompute jobs are scoped to owned caches today.
   */
  private async groupByOwner(
    cacheIds: readonly number[],
  ): Promise<Map<string, number[]>> {
    if (cacheIds.length === 0) return new Map();
    const { rows } = await sql<{ id: string; owner_id: string | null }>`
      SELECT id, owner_id
        FROM caches
       WHERE id IN (${sql.join([...cacheIds])})
         AND owner_id IS NOT NULL
    `.execute(this.db);
    const out = new Map<string, number[]>();
    for (const r of rows) {
      const list = out.get(r.owner_id!);
      if (list) list.push(Number(r.id));
      else out.set(r.owner_id!, [Number(r.id)]);
    }
    return out;
  }

  private async enqueue(
    kind: Admin.PrecomputeKind,
    ownerId: string,
    cacheIds: number[],
    reason: "upload" | "retrigger-stale" | "retrigger-one",
  ): Promise<string> {
    // Only 'walking' remains after ADR-0009. Keeping the `kind` parameter
    // for callsite symmetry with the wire types.
    void kind;
    const data = { ownerId, newCacheIds: cacheIds, reason };
    const job = await this.walkingQueue.add("precompute", data);
    return job.id ?? `precompute-${Date.now()}`;
  }

  private staleTtlDays(): number {
    return this.envInt("PRECOMPUTE_STALE_TTL_DAYS", DEFAULT_STALE_TTL_DAYS);
  }

  private envInt(name: string, fallback: number): number {
    const raw = this.config.get<string>(name);
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
}
