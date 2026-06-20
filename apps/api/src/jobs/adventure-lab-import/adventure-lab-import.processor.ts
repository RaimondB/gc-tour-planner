// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { parseGpx } from "@gctp/shared/gpx";
import type { Job } from "bullmq";
import { CachesRepository } from "../../caches/caches.repository.js";
import { QUEUE_ADVENTURE_LAB_IMPORT } from "../../queues/queue.tokens.js";
import { AdventureLabEnricher } from "../../sources/adventure-lab/al-enricher.service.js";
import { groupStagesForBackfill } from "./adventure-lab-backfill.js";
import type {
  AdventureLabBackfillJobData,
  AdventureLabBackfillJobResult,
  AdventureLabImportJobData,
  AdventureLabImportJobResult,
  AdventureLabQueueData,
} from "./adventure-lab-import.types.js";

/** Queue job name for the adventure_id backfill (FR-I17). */
export const BACKFILL_JOB_NAME = "backfill-ids";
/** Lab2Gpx adventures fetched per re-fetch — small; we centre on one adventure. */
const BACKFILL_LIMIT_ADVENTURES = 8;

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

  constructor(
    private readonly enricher: AdventureLabEnricher,
    private readonly cachesRepo: CachesRepository,
  ) {
    super();
  }

  async process(
    job: Job<
      AdventureLabQueueData,
      AdventureLabImportJobResult | AdventureLabBackfillJobResult
    >,
  ): Promise<AdventureLabImportJobResult | AdventureLabBackfillJobResult> {
    if (job.name === BACKFILL_JOB_NAME) {
      const { ownerId } = job.data as AdventureLabBackfillJobData;
      return this.backfillAdventureIds(ownerId);
    }
    const { ownerId, center, radiusM, maxAdventures } =
      job.data as AdventureLabImportJobData;
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

  /**
   * FR-I17 backfill: for every Adventure Lab stage missing an `adventure_id`,
   * re-fetch its adventure's area from Lab2Gpx and fill the id from the fresh
   * `goto/<guid>` deep-link, matched by LC code. Surgical — touches only
   * `adventure_id`, never re-ingests — so it can't disturb other cache fields or
   * trigger a precompute storm. Best-effort per adventure: a failed/empty fetch
   * leaves that adventure for a later run.
   */
  private async backfillAdventureIds(
    ownerId: string,
  ): Promise<AdventureLabBackfillJobResult> {
    if (!this.enricher.enabled) {
      this.logger.warn(
        "adventure_id backfill skipped — Adventure Lab enrichment disabled.",
      );
      return { adventuresTargeted: 0, stagesFixed: 0, stagesRemaining: 0 };
    }
    const affected =
      await this.cachesRepo.findAlStagesMissingAdventureId(ownerId);
    const groups = groupStagesForBackfill(affected);
    let fixed = 0;
    for (const g of groups) {
      let gpx: string | null = null;
      try {
        gpx = await this.enricher.fetchAreaGpx(
          { center: g.center, radiusM: g.radiusM },
          { limitAdventures: BACKFILL_LIMIT_ADVENTURES, bufferKm: 0 },
        );
      } catch (err) {
        this.logger.warn(
          `backfill: Lab2Gpx fetch failed for "${g.title}": ${(err as Error).message}`,
        );
        continue;
      }
      if (!gpx) continue;
      let idByCode: Map<string, string>;
      try {
        idByCode = new Map(
          parseGpx(gpx)
            .caches.filter((c) => c.adventureId)
            .map((c) => [c.code, c.adventureId!]),
        );
      } catch (err) {
        this.logger.warn(
          `backfill: GPX parse failed for "${g.title}": ${(err as Error).message}`,
        );
        continue;
      }
      for (const code of g.codes) {
        const advId = idByCode.get(code);
        if (advId)
          fixed += await this.cachesRepo.setAdventureIdIfMissing(
            ownerId,
            code,
            advId,
          );
      }
    }
    const stagesRemaining = (
      await this.cachesRepo.findAlStagesMissingAdventureId(ownerId)
    ).length;
    this.logger.log(
      `adventure_id backfill (owner=${ownerId}): ${groups.length} adventure(s) targeted, ` +
        `${fixed} stage(s) fixed, ${stagesRemaining} still missing`,
    );
    return {
      adventuresTargeted: groups.length,
      stagesFixed: fixed,
      stagesRemaining,
    };
  }
}
