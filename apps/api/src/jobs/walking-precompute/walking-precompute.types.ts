// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Payload for the `walking-precompute` BullMQ job. Producers (upload
 * service, admin retrigger) and the consumer processor both reference this
 * shape — keep it minimal and serializable.
 *
 * `reason` is logged with the job result so it's clear in the dashboard
 * whether a stale-count spike came from a real upload, an operator
 * retrigger, or a single-cache retry.
 */
export interface WalkingPrecomputeJobData {
  ownerId: string;
  newCacheIds: number[];
  reason: "upload" | "retrigger-stale" | "retrigger-one";
}

export interface WalkingPrecomputeJobResult {
  inScopeCount: number;
  pairsFetched: number;
  pairsAlreadyFresh: number;
  durationMs: number;
}
