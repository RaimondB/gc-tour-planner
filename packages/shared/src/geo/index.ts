// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";

/** [lng, lat] tuple in WGS84 / EPSG:4326. */
export const LngLat = z.tuple([
  z.number().gte(-180).lte(180),
  z.number().gte(-90).lte(90),
]);
export type LngLat = z.infer<typeof LngLat>;

export const GeoJsonPoint = z.object({
  type: z.literal("Point"),
  coordinates: LngLat,
});
export type GeoJsonPoint = z.infer<typeof GeoJsonPoint>;

export const GeoJsonLineString = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(LngLat).min(2),
});
export type GeoJsonLineString = z.infer<typeof GeoJsonLineString>;

/** A single linear ring; first and last coordinate must be identical (GeoJSON spec). */
export const GeoJsonPolygon = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(LngLat).min(4)).min(1),
});
export type GeoJsonPolygon = z.infer<typeof GeoJsonPolygon>;

/**
 * Array of polygon coordinates (outer ring + optional inner holes per
 * polygon). osm2pgsql normalises closed ways AND multipolygon relations
 * to MultiPolygon so the landuse table has a uniform geometry type.
 */
export const GeoJsonMultiPolygon = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(z.array(LngLat).min(4)).min(1)).min(1),
});
export type GeoJsonMultiPolygon = z.infer<typeof GeoJsonMultiPolygon>;

/** Either a single-ring polygon or a multipolygon. */
export const GeoJsonAnyPolygon = z.union([
  GeoJsonPolygon,
  GeoJsonMultiPolygon,
]);
export type GeoJsonAnyPolygon = z.infer<typeof GeoJsonAnyPolygon>;

export const BoundingBox = z.object({
  minLng: z.number(),
  minLat: z.number(),
  maxLng: z.number(),
  maxLat: z.number(),
});
export type BoundingBox = z.infer<typeof BoundingBox>;
