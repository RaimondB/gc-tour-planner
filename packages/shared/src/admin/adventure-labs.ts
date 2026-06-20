// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { LngLat } from "../geo/index.js";

/**
 * Admin-triggered bulk Adventure Lab import (FR-I15). Enqueues a background job
 * that fetches every Adventure Lab in the area from Lab2Gpx and imports the
 * stages — the heavy whole-area fetch that must never run inline on a request.
 */
export const AdventureLabImportRequest = z.object({
  center: LngLat,
  radiusM: z.number().int().positive().max(50_000),
  /**
   * Max adventures to fetch (Lab2Gpx `limit` counts adventures, ~5-10 stages
   * each). Generous default so a region is fully captured in one pass.
   */
  maxAdventures: z.number().int().positive().max(5_000).default(2_000),
});
export type AdventureLabImportRequest = z.infer<
  typeof AdventureLabImportRequest
>;

export const AdventureLabImportResponse = z.object({
  /** BullMQ job id for the enqueued background import. */
  jobId: z.string(),
});
export type AdventureLabImportResponse = z.infer<
  typeof AdventureLabImportResponse
>;
