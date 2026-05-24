// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { LngLat } from "../geo/index.js";
import { CacheType, WaypointType } from "../caches/index.js";

export const ParsedAttribute = z.object({
  id: z.number().int().positive(),
  positive: z.boolean(),
});
export type ParsedAttribute = z.infer<typeof ParsedAttribute>;

export const ParsedCache = z.object({
  sourceId: z.string(),
  code: z.string(),
  type: CacheType,
  name: z.string(),
  location: LngLat,
  difficulty: z.number().min(1).max(5).nullable(),
  terrain: z.number().min(1).max(5).nullable(),
  size: z.string().nullable(),
  archived: z.boolean(),
  attributes: z.array(ParsedAttribute),
});
export type ParsedCache = z.infer<typeof ParsedCache>;

export const ParsedWaypoint = z.object({
  parentCode: z.string(),
  type: WaypointType,
  name: z.string(),
  location: LngLat,
  note: z.string().nullable(),
});
export type ParsedWaypoint = z.infer<typeof ParsedWaypoint>;

export const ParsedGpx = z.object({
  caches: z.array(ParsedCache),
  waypoints: z.array(ParsedWaypoint),
  warnings: z.array(z.string()),
});
export type ParsedGpx = z.infer<typeof ParsedGpx>;
