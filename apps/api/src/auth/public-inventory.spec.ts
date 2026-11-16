// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import "reflect-metadata";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { IS_PUBLIC_KEY } from "./public.decorator.js";

// Every HTTP controller in the app. Adding a controller here is intentional
// friction — a new no-auth surface must be a deliberate, reviewed change.
import { AuthController } from "./auth.controller.js";
import { CachesController } from "../caches/caches.controller.js";
import { GpxController } from "../gpx/gpx.controller.js";
import { HealthController } from "../health/health.controller.js";
import { IngestController } from "../ingest/ingest.controller.js";
import { OsmController } from "../osm/osm.controller.js";
import { ParkingFacilitiesController } from "../osm/parking-facilities.controller.js";
import { RoutingController } from "../routing/routing.controller.js";
import { ToursController } from "../tours/tours.controller.js";
import { SharedTourController } from "../tours/shared-tour.controller.js";
import { LanduseProfilesController } from "../landuse-profiles/landuse-profiles.controller.js";
import { AdminUploadsController } from "../admin/uploads/admin-uploads.controller.js";
import { AdminPrecomputeController } from "../admin/precompute/admin-precompute.controller.js";
import { AdminLanduseController } from "../admin/landuse/admin-landuse.controller.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor = new (...args: any[]) => object;

const CONTROLLERS: Ctor[] = [
  AuthController,
  CachesController,
  GpxController,
  HealthController,
  IngestController,
  OsmController,
  ParkingFacilitiesController,
  RoutingController,
  ToursController,
  SharedTourController,
  LanduseProfilesController,
  AdminUploadsController,
  AdminPrecomputeController,
  AdminLanduseController,
];

/**
 * The normative public-endpoint inventory (FR-P11 / design §7 / ADR-0021,
 * ADR-0022). Any change to the live `@Public()` set must update this expectation
 * in the same PR — that is the whole point of the test: the no-auth surface
 * cannot drift silently.
 */
const EXPECTED_PUBLIC = new Set<string>([
  "POST /auth/register",
  "POST /auth/login",
  "GET /auth/google",
  "GET /auth/google/callback",
  "GET /health",
  "GET /shared/:slug",
]);

const METHOD_NAME: Record<number, string> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.OPTIONS]: "OPTIONS",
  [RequestMethod.HEAD]: "HEAD",
  [RequestMethod.ALL]: "ALL",
};

function joinPath(base: string, sub: string): string {
  const parts = `${base}/${sub}`.split("/").filter(Boolean);
  return `/${parts.join("/")}`;
}

/** Walk every controller's route handlers and collect those marked @Public(). */
function collectPublicRoutes(): Set<string> {
  const out = new Set<string>();

  for (const Controller of CONTROLLERS) {
    const base =
      (Reflect.getMetadata(PATH_METADATA, Controller) as string) ?? "";
    const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, Controller) === true;

    const proto = Controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const handler = proto[name];
      if (typeof handler !== "function") continue;

      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        | number
        | undefined;
      if (method === undefined) continue; // not a route handler

      const methodPublic = Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
      if (!classPublic && !methodPublic) continue;

      const sub = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? "";
      out.add(`${METHOD_NAME[method] ?? method} ${joinPath(base, sub)}`);
    }
  }
  return out;
}

describe("public-endpoint inventory (FR-P11 — normative security contract)", () => {
  it("the live @Public() set exactly matches the documented inventory", () => {
    const actual = collectPublicRoutes();
    // Compare as sorted arrays so a mismatch prints both sides clearly.
    expect([...actual].sort()).toEqual([...EXPECTED_PUBLIC].sort());
  });
});
