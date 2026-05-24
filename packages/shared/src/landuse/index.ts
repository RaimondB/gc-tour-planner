// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { BoundingBox, GeoJsonPolygon } from "../geo/index.js";

/**
 * Canonical OSM landuse kinds we display + filter on. Maps from a mix of
 * OSM tags (landuse=*, natural=*, leisure=*). The mapping happens in the API
 * (apps/api/src/osm/landuse-classify.ts); clients only see these names.
 */
export const LANDUSE_KINDS = [
  "forest",
  "park",
  "residential",
  "farmland",
  "industrial",
  "meadow",
  "water",
  "wetland",
  "heath",
  "scrub",
] as const;
export const LanduseKind = z.enum(LANDUSE_KINDS);
export type LanduseKind = z.infer<typeof LanduseKind>;

export const LanduseQuery = z.object({
  bbox: BoundingBox,
  /** Empty array = all kinds. */
  kinds: z.array(LanduseKind).optional(),
});
export type LanduseQuery = z.infer<typeof LanduseQuery>;

export const LanduseFeatureProps = z.object({
  id: z.number().int().positive(),
  kind: LanduseKind,
});
export type LanduseFeatureProps = z.infer<typeof LanduseFeatureProps>;

export const LanduseFeature = z.object({
  type: z.literal("Feature"),
  properties: LanduseFeatureProps,
  geometry: GeoJsonPolygon,
});
export type LanduseFeature = z.infer<typeof LanduseFeature>;

export const LanduseResponse = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(LanduseFeature),
});
export type LanduseResponse = z.infer<typeof LanduseResponse>;
