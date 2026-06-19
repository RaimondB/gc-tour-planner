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
