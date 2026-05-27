// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Database } from "@gctp/db";
import type { Job } from "bullmq";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../../database/database.tokens.js";
import { LanduseRepository } from "../../osm/landuse.repository.js";
import { QUEUE_LANDUSE_REPLICATION } from "../../queues/queue.tokens.js";
import type {
  LanduseReplicationJobData,
  LanduseReplicationJobResult,
} from "./landuse-replication.types.js";

/**
 * Postgres advisory-lock id used to serialise concurrent landuse
 * replication attempts (cron + manual click + retry). The number is
 * arbitrary but must be globally unique across the gctp schema.
 */
const ADVISORY_LOCK_ID = 909_001n;

/** Minimum time between successful replication runs (12 h). */
const MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Tracks heartbeat + audit of landuse_polygons diff replication
 * (ADR-0009 — supersedes the per-upload `overpass-refresh` queue).
 *
 * The actual `osm2pgsql-replication update` invocation lives in the
 * `osm2pgsql-import` compose service (where osm2pgsql is installed). This
 * processor:
 *   1. Tries to acquire an advisory lock (so cron + manual triggers don't
 *      stomp on each other or on a running osm2pgsql-import process).
 *   2. Checks the 12 h minimum-interval guard via `landuse_import_meta`.
 *   3. Records the attempt + state on `landuse_import_meta`.
 *
 * The actual diff-apply is operator-driven (admin `/landuse/reimport`
 * button restarts the import service with `LANDUSE_FORCE_REIMPORT=1`)
 * until a host-side systemd timer ships in a follow-up.
 */
@Processor(QUEUE_LANDUSE_REPLICATION)
export class LanduseReplicationProcessor extends WorkerHost {
  private readonly logger = new Logger(LanduseReplicationProcessor.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly landuse: LanduseRepository,
  ) {
    super();
  }

  async process(
    job: Job<LanduseReplicationJobData, LanduseReplicationJobResult>,
  ): Promise<LanduseReplicationJobResult> {
    const startedAt = Date.now();
    const reason = job.data.reason;
    this.logger.log(`landuse-replication (${reason}) starting`);

    const meta = await this.landuse.lastImportMeta();
    if (!meta) {
      const state =
        "skip: no landuse_import_meta row yet (run osm2pgsql-import first)";
      this.logger.warn(state);
      return { ran: false, state, durationMs: Date.now() - startedAt };
    }

    const lastEvent = meta.replicatedAt ?? meta.importedAt;
    const sinceMs = Date.now() - lastEvent.getTime();
    if (reason === "scheduled" && sinceMs < MIN_INTERVAL_MS) {
      const state = `skip: last activity ${Math.round(sinceMs / 3_600_000)}h ago (<12h gate)`;
      this.logger.log(state);
      return { ran: false, state, durationMs: Date.now() - startedAt };
    }

    // Advisory lock: pg_try_advisory_xact_lock returns true if acquired,
    // false if another tx holds it. Held until tx commit/rollback.
    const lockResult = await sql<{
      pg_try_advisory_xact_lock: boolean;
    }>`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_ID})`.execute(this.db);
    const acquired = lockResult.rows[0]?.pg_try_advisory_xact_lock ?? false;
    if (!acquired) {
      const state = "skip: another replication holds the advisory lock";
      this.logger.warn(state);
      return { ran: false, state, durationMs: Date.now() - startedAt };
    }

    // Heartbeat only — the actual osm2pgsql-replication binary lives in
    // the osm2pgsql-import compose service. A follow-up adds a host
    // systemd timer that calls
    //   `docker compose -p gctp run --rm osm2pgsql-import \
    //      /srv/bootstrap.sh replicate`
    // and reports the exit code back here. For now we record the heartbeat
    // so the admin panel can show "BullMQ is alive" even before the
    // operator wires the timer.
    const state = `heartbeat: ${reason}; binary lives in osm2pgsql-import container`;
    await this.landuse.recordReplication(state);

    const durationMs = Date.now() - startedAt;
    this.logger.log(`landuse-replication done in ${durationMs}ms`);
    return { ran: true, state, durationMs };
  }
}
