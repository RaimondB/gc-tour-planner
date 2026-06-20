// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { InjectQueue } from "@nestjs/bullmq";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { Admin } from "@gctp/shared";
import type { Queue } from "bullmq";
import { QUEUE_ADVENTURE_LAB_IMPORT } from "../../queues/queue.tokens.js";
import type { AdventureLabQueueData } from "../../jobs/adventure-lab-import/adventure-lab-import.types.js";
import { BACKFILL_JOB_NAME } from "../../jobs/adventure-lab-import/adventure-lab-import.processor.js";
import {
  ADVENTURE_LAB_CONFIG,
  type AdventureLabConfig,
} from "../../sources/adventure-lab/al.config.js";

@Injectable()
export class AdminAdventureLabsService {
  constructor(
    @InjectQueue(QUEUE_ADVENTURE_LAB_IMPORT)
    private readonly queue: Queue<AdventureLabQueueData>,
    @Inject(ADVENTURE_LAB_CONFIG)
    private readonly config: AdventureLabConfig,
  ) {}

  async enqueueImport(
    ownerId: string,
    req: Admin.AdventureLabImportRequest,
  ): Promise<Admin.AdventureLabImportResponse> {
    if (!this.config.enabled) {
      throw new BadRequestException(
        "Adventure Lab enrichment is disabled (set ADVENTURE_LAB_ENRICHMENT_ENABLED=1).",
      );
    }
    const job = await this.queue.add("import", {
      ownerId,
      center: req.center,
      radiusM: req.radiusM,
      maxAdventures: req.maxAdventures,
    });
    return { jobId: String(job.id) };
  }

  /**
   * FR-I17: enqueue the adventure_id backfill — re-fetch every Adventure Lab
   * stage that's missing an `adventure_id` (older uploads whose GPX had no
   * `goto/<guid>` deep-link) from Lab2Gpx and fill it in. Runs as a background
   * job (it makes one Lab2Gpx call per affected adventure).
   */
  async enqueueBackfill(
    ownerId: string,
  ): Promise<Admin.AdventureLabImportResponse> {
    if (!this.config.enabled) {
      throw new BadRequestException(
        "Adventure Lab enrichment is disabled (set ADVENTURE_LAB_ENRICHMENT_ENABLED=1).",
      );
    }
    const job = await this.queue.add(BACKFILL_JOB_NAME, { ownerId });
    return { jobId: String(job.id) };
  }
}
