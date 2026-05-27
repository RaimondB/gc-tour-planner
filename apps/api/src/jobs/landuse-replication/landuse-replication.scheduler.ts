// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { QUEUE_LANDUSE_REPLICATION } from "../../queues/queue.tokens.js";
import type { LanduseReplicationJobData } from "./landuse-replication.types.js";

/** Daily landuse-replication tick at 04:00 host time. */
const REPEAT_CRON = "0 4 * * *";
const REPEAT_JOB_NAME = "scheduled-replication";

/**
 * Registers the daily landuse-replication tick (ADR-0009).
 *
 * BullMQ's `repeatable` jobs are idempotent on registration as long as the
 * `pattern` + `jobId` stay the same — restart-safe. The processor handles
 * the actual work; this class only owns the schedule.
 */
@Injectable()
export class LanduseReplicationScheduler implements OnModuleInit {
  private readonly logger = new Logger(LanduseReplicationScheduler.name);

  constructor(
    @InjectQueue(QUEUE_LANDUSE_REPLICATION)
    private readonly queue: Queue<LanduseReplicationJobData>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      REPEAT_JOB_NAME,
      { reason: "scheduled" },
      {
        repeat: { pattern: REPEAT_CRON },
        jobId: REPEAT_JOB_NAME,
      },
    );
    this.logger.log(
      `daily landuse-replication tick registered (cron: ${REPEAT_CRON})`,
    );
  }
}
