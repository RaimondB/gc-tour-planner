// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { GeoJsonLineString } from "../geo/index.js";

/**
 * Routing profiles supported by the OSRM container. MVP ships 'foot' only;
 * other profiles need a second OSRM instance (or a multi-profile setup) and
 * are deferred until a real user need surfaces.
 */
export const RoutingProfile = z.enum(["foot"]);
export type RoutingProfile = z.infer<typeof RoutingProfile>;

export const Leg = z.object({
  fromCacheId: z.number().int().positive(),
  toCacheId: z.number().int().positive(),
  profile: RoutingProfile,
  meters: z.number().nonnegative(),
  seconds: z.number().nonnegative(),
  geometry: GeoJsonLineString,
});
export type Leg = z.infer<typeof Leg>;

/**
 * Symmetric OD matrix shape. `legs[i][j]` is the leg from `cacheIds[i]` to
 * `cacheIds[j]` (or `null` if OSRM couldn't route the pair — disconnected
 * graph). Diagonals are always { meters: 0, seconds: 0, geometry: trivial }.
 */
export const MatrixEntry = z.object({
  meters: z.number().nonnegative(),
  seconds: z.number().nonnegative(),
});
export type MatrixEntry = z.infer<typeof MatrixEntry>;

export const Matrix = z.object({
  profile: RoutingProfile,
  cacheIds: z.array(z.number().int().positive()),
  legs: z.array(z.array(MatrixEntry.nullable())),
});
export type Matrix = z.infer<typeof Matrix>;
