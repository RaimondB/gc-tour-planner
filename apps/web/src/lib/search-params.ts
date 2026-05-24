// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { CacheType } from "@gctp/shared/caches";

export interface SearchParams {
  center: [number, number]; // [lng, lat]
  radiusM: number;
  types: CacheType[]; // empty = "any type"
  excludeFound: boolean;
}

export const DEFAULT_SEARCH: SearchParams = {
  center: [5.1214, 52.0907], // Utrecht — placeholder until "use my location"
  radiusM: 5_000,
  types: [],
  excludeFound: false,
};
