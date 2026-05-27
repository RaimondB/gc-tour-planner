// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Database } from "@gctp/db";
import type { Admin } from "@gctp/shared";
import type { Queue } from "bullmq";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../../database/database.tokens.js";
import { LanduseRepository } from "../../osm/landuse.repository.js";
import { QUEUE_LANDUSE_REPLICATION } from "../../queues/queue.tokens.js";
import type { LanduseReplicationJobData } from "../../jobs/landuse-replication/landuse-replication.types.js";

/**
 * Admin surface for the osm2pgsql-fed landuse pipeline (ADR-0009).
 *
 * Two endpoints back this:
 *   - `GET /admin/landuse/status` — current import + replication health.
 *   - `POST /admin/landuse/reimport` — enqueue a manual replication job
 *     to refresh the heartbeat. Full re-imports (drop + osm2pgsql --create
 *     from scratch) live in the `osm2pgsql-import` compose service;
 *     operators trigger them with
 *     `LANDUSE_FORCE_REIMPORT=1 docker compose -p gctp run --rm osm2pgsql-import`.
 */
@Injectable()
export class AdminLanduseService {
  private readonly logger = new Logger(AdminLanduseService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly landuse: LanduseRepository,
    @InjectQueue(QUEUE_LANDUSE_REPLICATION)
    private readonly queue: Queue<LanduseReplicationJobData>,
  ) {}

  async status(): Promise<Admin.LanduseStatus> {
    const [meta, countRow] = await Promise.all([
      this.landuse.lastImportMeta(),
      sql<{ n: string }>`SELECT count(*)::text AS n FROM landuse_polygons`.execute(
        this.db,
      ),
    ]);
    const polygonCount = Number(countRow.rows[0]?.n ?? 0);
    return {
      importedAt: meta?.importedAt ? meta.importedAt.toISOString() : null,
      pbfTimestamp: meta?.pbfTimestamp ? meta.pbfTimestamp.toISOString() : null,
      sourceFile: meta?.sourceFile ?? null,
      replicatedAt: meta?.replicatedAt ? meta.replicatedAt.toISOString() : null,
      replicationState: meta?.replicationState ?? null,
      polygonCount,
    };
  }

  async enqueueReimport(): Promise<Admin.LanduseReimportResponse> {
    const job = await this.queue.add("manual-replication", {
      reason: "manual",
    });
    this.logger.log(`landuse-replication manual enqueue jobId=${job.id}`);
    return {
      jobId: job.id ?? "unknown",
      note:
        "Manual replication enqueued. For a full re-import of the PBF, " +
        "set LANDUSE_FORCE_REIMPORT=1 and run " +
        "`docker compose -p gctp run --rm osm2pgsql-import`.",
    };
  }
}
