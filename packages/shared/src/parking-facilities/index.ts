// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { BoundingBox, GeoJsonAnyPolygon, GeoJsonPoint } from "../geo/index.js";

/**
 * Wire schemas for the `/parking-facilities` HTTP surface (ADR-0011).
 *
 * `amenity=parking` features are ingested into `parking_facilities` by the
 * same osm2pgsql pass that populates `landuse_polygons`. The client filters
 * by access (public-ish only by default) and fee (free / paid / any), then
 * either renders the result on the map (`OsmParkingLayer`) or feeds it
 * into the planner as a `startPreference="osm-parking"` candidate set.
 */

/**
 * OSM `access` values we expose as user-facing filter chips. The wider
 * universe (private, no, destination, ...) is rendered on the map for
 * context but never proposed as a tour start.
 */
export const PARKING_ACCESS_CHIPS = ["yes", "customers", "permit"] as const;
export const ParkingAccessChip = z.enum(PARKING_ACCESS_CHIPS);
export type ParkingAccessChip = z.infer<typeof ParkingAccessChip>;

export const PARKING_FEE_FILTER = ["free", "paid", "any"] as const;
export const ParkingFeeFilter = z.enum(PARKING_FEE_FILTER);
export type ParkingFeeFilter = z.infer<typeof ParkingFeeFilter>;

export const ParkingFacilitiesQuery = z.object({
  bbox: BoundingBox,
  /**
   * Restrict to these `access` values. Empty array = no restriction. When
   * omitted on the server the default policy is applied (yes + customers;
   * permit is opt-in per ADR-0011).
   */
  access: z.array(ParkingAccessChip).optional(),
  fee: ParkingFeeFilter.optional(),
});
export type ParkingFacilitiesQuery = z.infer<typeof ParkingFacilitiesQuery>;

export const ParkingFacilityProps = z.object({
  osmId: z.number().int(),
  // osm2pgsql flex stores uppercase: N (node), W (way), R (relation).
  osmType: z.enum(["N", "W", "R"]),
  /** Raw OSM tag values (no normalisation beyond `parking:condition` → fee). */
  access: z.string().nullable(),
  fee: z.string().nullable(),
  parkingType: z.string().nullable(),
  capacity: z.number().int().nonnegative().nullable(),
  maxstay: z.string().nullable(),
  supervised: z.string().nullable(),
  openingHours: z.string().nullable(),
  surface: z.string().nullable(),
  name: z.string().nullable(),
});
export type ParkingFacilityProps = z.infer<typeof ParkingFacilityProps>;

export const ParkingFacilityFeature = z.object({
  type: z.literal("Feature"),
  properties: ParkingFacilityProps,
  /** Point for node parkings, (Multi)Polygon for ways / relations. */
  geometry: z.union([GeoJsonPoint, GeoJsonAnyPolygon]),
});
export type ParkingFacilityFeature = z.infer<typeof ParkingFacilityFeature>;

export const ParkingFacilitiesResponse = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(ParkingFacilityFeature),
});
export type ParkingFacilitiesResponse = z.infer<typeof ParkingFacilitiesResponse>;
