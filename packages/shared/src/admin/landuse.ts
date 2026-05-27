// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";

/**
 * Health view of the osm2pgsql-fed landuse pipeline (ADR-0009).
 *
 * `imported_at` is the most recent successful full import (one-shot or
 * forced reimport). `replicated_at` is the most recent diff-apply or
 * heartbeat from the daily replication job. `replication_state` is a
 * short free-text status ('heartbeat: …', 'ok', 'error: …', or null
 * before any replication run).
 */
export const LanduseStatus = z.object({
  importedAt: z.string().nullable(),
  pbfTimestamp: z.string().nullable(),
  sourceFile: z.string().nullable(),
  replicatedAt: z.string().nullable(),
  replicationState: z.string().nullable(),
  /** Total polygon count in landuse_polygons. */
  polygonCount: z.number().int().nonnegative(),
});
export type LanduseStatus = z.infer<typeof LanduseStatus>;

export const LanduseReimportResponse = z.object({
  jobId: z.string(),
  /** Free-text confirmation. */
  note: z.string(),
});
export type LanduseReimportResponse = z.infer<typeof LanduseReimportResponse>;
