// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";

/**
 * Health view of the osm2pgsql-fed landuse pipeline (ADR-0009 +
 * ADR-0010 simplification).
 *
 * `imported_at` is the most recent successful full import. Refreshes
 * are operator-driven via `scripts/refresh-osm-data.sh` (kept in
 * lockstep with OSRM), not by a daily BullMQ job — the `replicated_at`
 * and `replication_state` fields are retained on the wire for back-
 * compat but are always null until a future incremental-update path
 * (if any) is wired up.
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
