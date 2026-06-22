// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { parseGpx } from "@gctp/shared/gpx";
import type { Job } from "bullmq";
import { CachesRepository } from "../../caches/caches.repository.js";
import { QUEUE_ADVENTURE_LAB_IMPORT } from "../../queues/queue.tokens.js";
import { AdventureLabEnricher } from "../../sources/adventure-lab/al-enricher.service.js";
import { coordKey, groupStagesForBackfill } from "./adventure-lab-backfill.js";
import type {
  AdventureLabBackfillJobData,
  AdventureLabBackfillJobResult,
  AdventureLabImportJobData,
  AdventureLabImportJobResult,
  AdventureLabQueueData,
  AdventureLabSyncJobData,
  AdventureLabSyncJobResult,
} from "./adventure-lab-import.types.js";

/** Queue job name for the adventure_id backfill (FR-I17). */
export const BACKFILL_JOB_NAME = "backfill-ids";
/** Queue job name for the user-triggered area sync (FR-I19). */
export const SYNC_JOB_NAME = "sync";
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
    if (job.name === SYNC_JOB_NAME) {
      return this.syncArea(job as Job, job.data as AdventureLabSyncJobData);
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
   * FR-I19 area sync: refresh every Adventure Lab in the area from Lab2Gpx and
   * cross off the user's completed stages, reporting coarse progress phases so
   * the web button can show a live status. Reuses the enricher (same import path
   * as the admin bulk import); idempotent, so a retry is safe.
   */
  private async syncArea(
    job: Job,
    data: AdventureLabSyncJobData,
  ): Promise<AdventureLabSyncJobResult> {
    await job.updateProgress({ phase: "queued" });
    const result = await this.enricher.enrich(
      data.ownerId,
      { center: data.center, radiusM: data.radiusM },
      {},
      (phase) => void job.updateProgress({ phase }),
    );
    await job.updateProgress({ phase: "done" });
    const out = {
      importedCaches: result?.importedCaches ?? 0,
      crossedOff: result?.crossedOff ?? 0,
    };
    this.logger.log(
      `Adventure Lab sync (owner=${data.ownerId}, r=${data.radiusM}m): ` +
        `${out.importedCaches} stage(s) upserted, ${out.crossedOff} crossed off`,
    );
    return out;
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
      return {
        adventuresTargeted: 0,
        stagesFixed: 0,
        dupesRemoved: 0,
        stagesRemaining: 0,
      };
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
      // Index the fresh stages by both code and coordinate. Code is the primary
      // key; coordinate is the fallback for stages stored under a different code
      // scheme (the hyphenated "LC…-1" legacy import) than the current fetch.
      const byCode = new Map<string, string>();
      const byCoord = new Map<string, string>();
      try {
        for (const c of parseGpx(gpx).caches) {
          if (!c.adventureId) continue;
          byCode.set(c.code, c.adventureId);
          byCoord.set(coordKey(c.location[0], c.location[1]), c.adventureId);
        }
      } catch (err) {
        this.logger.warn(
          `backfill: GPX parse failed for "${g.title}": ${(err as Error).message}`,
        );
        continue;
      }
      for (const m of g.members) {
        const advId = byCode.get(m.code) ?? byCoord.get(coordKey(m.lng, m.lat));
        if (advId)
          fixed += await this.cachesRepo.setAdventureIdByIdIfMissing(
            ownerId,
            m.id,
            advId,
          );
      }
    }
    // Filling adventure_id can expose duplicates (the same adventure imported
    // under two code schemes) that were invisible while the id was null — dedup
    // them now so the freshly-grouped adventures don't show double their stages.
    const dupesRemoved = await this.cachesRepo.dedupAdventureStages(ownerId);
    const stagesRemaining = (
      await this.cachesRepo.findAlStagesMissingAdventureId(ownerId)
    ).length;
    this.logger.log(
      `adventure_id backfill (owner=${ownerId}): ${groups.length} adventure(s) targeted, ` +
        `${fixed} stage(s) fixed, ${dupesRemoved} duplicate(s) removed, ${stagesRemaining} still missing`,
    );
    return {
      adventuresTargeted: groups.length,
      stagesFixed: fixed,
      dupesRemoved,
      stagesRemaining,
    };
  }
}
