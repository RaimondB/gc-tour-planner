// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Payload for the daily landuse-replication job (ADR-0009).
 *
 * `reason` is human-facing only; the job behaves the same regardless.
 */
export interface LanduseReplicationJobData {
  reason: "scheduled" | "manual";
}

export interface LanduseReplicationJobResult {
  /** Whether replication ran (false when the advisory lock was busy). */
  ran: boolean;
  /** Free-text state recorded on `landuse_import_meta.replication_state`. */
  state: string;
  durationMs: number;
}
