// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Normative MACHINE-auth inventory (FR-I14 / ADR-0033). Sibling of the
// public-endpoint inventory: machine routes authenticate by bearer token (not
// a session cookie), so the global session guard steps aside for them. Any
// change to the live `@MachineAuth()` set must update this expectation in the
// same PR — the no-session surface cannot drift silently.

import "reflect-metadata";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { IS_MACHINE_KEY } from "../auth/machine-auth.decorator.js";

// Every HTTP controller in the app (kept in lockstep with public-inventory).
import { AuthController } from "../auth/auth.controller.js";
import { CachesController } from "../caches/caches.controller.js";
import { GpxController } from "../gpx/gpx.controller.js";
import { HealthController } from "../health/health.controller.js";
import { IngestController } from "./ingest.controller.js";
import { OsmController } from "../osm/osm.controller.js";
import { ParkingFacilitiesController } from "../osm/parking-facilities.controller.js";
import { RoutingController } from "../routing/routing.controller.js";
import { ToursController } from "../tours/tours.controller.js";
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
  LanduseProfilesController,
  AdminUploadsController,
  AdminPrecomputeController,
  AdminLanduseController,
];

/** The only route reachable without a browser session (bearer-protected). */
const EXPECTED_MACHINE = new Set<string>(["POST /ingest/gpx"]);

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

function collectMachineRoutes(): Set<string> {
  const out = new Set<string>();

  for (const Controller of CONTROLLERS) {
    const base =
      (Reflect.getMetadata(PATH_METADATA, Controller) as string) ?? "";
    const classMachine =
      Reflect.getMetadata(IS_MACHINE_KEY, Controller) === true;

    const proto = Controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const handler = proto[name];
      if (typeof handler !== "function") continue;

      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        | number
        | undefined;
      if (method === undefined) continue; // not a route handler

      const methodMachine =
        Reflect.getMetadata(IS_MACHINE_KEY, handler) === true;
      if (!classMachine && !methodMachine) continue;

      const sub = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? "";
      out.add(`${METHOD_NAME[method] ?? method} ${joinPath(base, sub)}`);
    }
  }
  return out;
}

describe("machine-auth inventory (FR-I14 — normative security contract)", () => {
  it("the live @MachineAuth() set exactly matches the documented inventory", () => {
    const actual = collectMachineRoutes();
    expect([...actual].sort()).toEqual([...EXPECTED_MACHINE].sort());
  });
});
