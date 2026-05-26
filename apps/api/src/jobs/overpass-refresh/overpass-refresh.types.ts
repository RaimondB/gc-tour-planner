// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

export interface OverpassRefreshJobData {
  ownerId: string;
  newCacheIds: number[];
  reason: "upload" | "retrigger-stale" | "retrigger-one";
}

export interface OverpassRefreshJobResult {
  inScopeCount: number;
  cellsRefreshed: number;
  cellsAlreadyFresh: number;
  durationMs: number;
}
