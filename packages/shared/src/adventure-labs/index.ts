// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { LngLat } from "../geo/index.js";

/**
 * User-triggered Adventure Lab sync for the current area (FR-I19). Refreshes
 * every Adventure Lab in the area from Lab2Gpx — new/archived/moved stages — and,
 * when the user has set their Geocaching GUID, crosses off completed stages. Runs
 * as a background job (the whole-area Lab2Gpx fetch is too heavy for a request),
 * so the client polls {@link AdventureLabSyncStatus} for progress.
 */
export const AdventureLabSyncRequest = z.object({
  center: LngLat,
  radiusM: z.number().int().positive().max(50_000),
});
export type AdventureLabSyncRequest = z.infer<typeof AdventureLabSyncRequest>;

export const AdventureLabSyncResponse = z.object({
  /** BullMQ job id — poll `GET /adventure-labs/sync/:jobId`. */
  jobId: z.string(),
});
export type AdventureLabSyncResponse = z.infer<typeof AdventureLabSyncResponse>;

/** Coarse lifecycle phases surfaced to the user while the sync job runs. */
export const AdventureLabSyncPhase = z.enum([
  "queued",
  "fetching",
  "importing",
  "completion",
  "done",
  "failed",
]);
export type AdventureLabSyncPhase = z.infer<typeof AdventureLabSyncPhase>;

/**
 * Progress snapshot for a sync job. `phase` drives the user-visible status line;
 * the count fields are populated once the job completes. `error` is a friendly
 * message on failure.
 */
export const AdventureLabSyncStatus = z.object({
  phase: AdventureLabSyncPhase,
  /** Stages upserted (new + refreshed). Present once done. */
  importedCaches: z.number().int().nonnegative().nullable().default(null),
  /** Completed stages crossed off (0 when no GC GUID is set). Present once done. */
  crossedOff: z.number().int().nonnegative().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type AdventureLabSyncStatus = z.infer<typeof AdventureLabSyncStatus>;
