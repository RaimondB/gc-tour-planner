// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { InjectQueue } from "@nestjs/bullmq";
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { AdventureLabs } from "@gctp/shared";
import type { Job, Queue } from "bullmq";
import type {
  AdventureLabQueueData,
  AdventureLabSyncJobData,
  AdventureLabSyncJobResult,
} from "../jobs/adventure-lab-import/adventure-lab-import.types.js";
import { SYNC_JOB_NAME } from "../jobs/adventure-lab-import/adventure-lab-import.processor.js";
import { QUEUE_ADVENTURE_LAB_IMPORT } from "../queues/queue.tokens.js";
import {
  ADVENTURE_LAB_CONFIG,
  type AdventureLabConfig,
} from "../sources/adventure-lab/al.config.js";

/**
 * User-facing Adventure Lab sync (FR-I19): the "Sync this area" button. Enqueues
 * the same enricher work the admin bulk import uses, scoped to the caller, and
 * exposes a poll-able status so the web can show live progress. Authenticated by
 * the global guard — no admin role required (a user syncs their own caches).
 */
@Injectable()
export class AdventureLabsService {
  constructor(
    @InjectQueue(QUEUE_ADVENTURE_LAB_IMPORT)
    private readonly queue: Queue<AdventureLabQueueData>,
    @Inject(ADVENTURE_LAB_CONFIG)
    private readonly config: AdventureLabConfig,
  ) {}

  async enqueueSync(
    ownerId: string,
    req: AdventureLabs.AdventureLabSyncRequest,
  ): Promise<AdventureLabs.AdventureLabSyncResponse> {
    if (!this.config.enabled) {
      throw new BadRequestException(
        "Adventure Lab sync is disabled on this server.",
      );
    }
    const data: AdventureLabSyncJobData = {
      ownerId,
      center: req.center,
      radiusM: req.radiusM,
    };
    const job = await this.queue.add(SYNC_JOB_NAME, data);
    return { jobId: String(job.id) };
  }

  /**
   * Progress snapshot for a sync job. Owner-scoped: a job whose `ownerId` is not
   * the caller's reads as not-found (no cross-user job inspection).
   */
  async getSyncStatus(
    ownerId: string,
    jobId: string,
  ): Promise<AdventureLabs.AdventureLabSyncStatus> {
    const job: Job<AdventureLabQueueData> | undefined =
      await this.queue.getJob(jobId);
    if (!job || (job.data as AdventureLabSyncJobData).ownerId !== ownerId) {
      throw new NotFoundException("Sync job not found");
    }
    const state = await job.getState();
    if (state === "completed") {
      const r = job.returnvalue as AdventureLabSyncJobResult | undefined;
      return {
        phase: "done",
        importedCaches: r?.importedCaches ?? 0,
        crossedOff: r?.crossedOff ?? 0,
        error: null,
      };
    }
    if (state === "failed") {
      return {
        phase: "failed",
        importedCaches: null,
        crossedOff: null,
        error: job.failedReason ?? "Sync failed",
      };
    }
    // waiting / active / delayed / etc. — report the coarse phase the worker set.
    const progress = job.progress as { phase?: string } | number | undefined;
    const phase =
      typeof progress === "object" && progress?.phase
        ? progress.phase
        : "queued";
    return {
      phase: toPhase(phase),
      importedCaches: null,
      crossedOff: null,
      error: null,
    };
  }
}

/** Coerce a worker-supplied progress phase to the wire enum (default queued). */
function toPhase(phase: string): AdventureLabs.AdventureLabSyncPhase {
  switch (phase) {
    case "fetching":
    case "importing":
    case "completion":
    case "done":
    case "failed":
      return phase;
    default:
      return "queued";
  }
}
