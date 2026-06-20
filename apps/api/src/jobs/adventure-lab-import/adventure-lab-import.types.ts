// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/** Payload for a bulk Adventure Lab area import (FR-I15). */
export interface AdventureLabImportJobData {
  /** Owner the imported stages are attributed to. */
  ownerId: string;
  center: [number, number];
  radiusM: number;
  /** Max adventures to fetch (Lab2Gpx `limit`). */
  maxAdventures: number;
}

export interface AdventureLabImportJobResult {
  importedCaches: number;
}

/**
 * Payload for the adventure_id backfill (FR-I17): re-fetch each of the owner's
 * Adventure Lab stages that lack an `adventure_id` from Lab2Gpx and fill it in.
 * No area — the job derives the affected adventures' locations itself.
 */
export interface AdventureLabBackfillJobData {
  ownerId: string;
}

export interface AdventureLabBackfillJobResult {
  /** Distinct adventures (by name) the job tried to re-fetch. */
  adventuresTargeted: number;
  /** Stages whose `adventure_id` was filled. */
  stagesFixed: number;
  /** Duplicate stage rows removed after filling (same code imported twice). */
  dupesRemoved: number;
  /** Stages still missing an `adventure_id` after the run (no Lab2Gpx match). */
  stagesRemaining: number;
}

/** Both job shapes share the `adventure-lab-import` queue, dispatched by name. */
export type AdventureLabQueueData =
  | AdventureLabImportJobData
  | AdventureLabBackfillJobData;
