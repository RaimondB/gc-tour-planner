// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { QUEUE_ADVENTURE_LAB_IMPORT } from "../../queues/queue.tokens.js";
import { AdventureLabEnricher } from "../../sources/adventure-lab/al-enricher.service.js";
import type {
  AdventureLabImportJobData,
  AdventureLabImportJobResult,
} from "./adventure-lab-import.types.js";

/**
 * Bulk Adventure Lab area import (FR-I15). The whole-area Lab2Gpx fetch is far
 * too heavy to run inline on a request (a dense 25 km area is 2,500+ stages), so
 * the admin endpoint enqueues it here and the worker imports it off-request via
 * the shared enricher (which pipes the GPX through the ordinary upsert path —
 * idempotent, so a retry can't double-insert).
 */
@Processor(QUEUE_ADVENTURE_LAB_IMPORT)
export class AdventureLabImportProcessor extends WorkerHost {
  private readonly logger = new Logger(AdventureLabImportProcessor.name);

  constructor(private readonly enricher: AdventureLabEnricher) {
    super();
  }

  async process(
    job: Job<AdventureLabImportJobData, AdventureLabImportJobResult>,
  ): Promise<AdventureLabImportJobResult> {
    const { ownerId, center, radiusM, maxAdventures } = job.data;
    const result = await this.enricher.enrich(
      ownerId,
      { center, radiusM },
      { limitAdventures: maxAdventures },
    );
    const importedCaches = result?.importedCaches ?? 0;
    this.logger.log(
      `Bulk Adventure Lab import (owner=${ownerId}, r=${radiusM}m, ` +
        `maxAdventures=${maxAdventures}): ${importedCaches} stage(s) upserted`,
    );
    return { importedCaches };
  }
}
