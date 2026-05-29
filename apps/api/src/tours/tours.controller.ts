// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Tours } from "@gctp/shared";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { ToursService } from "./tours.service.js";

/**
 * Two-pass tour-planning surface (see ADR-0002), plus a debugging explainer:
 *   POST /tours/clusters         — Pass 1: candidate clusters with score breakdown.
 *   POST /tours/plan             — Pass 2: routed closed loop on chosen cache ids.
 *   POST /tours/clusters/explain — diagnose an arbitrary cache selection
 *                                  (manual cluster picks or candidate-minus-caches).
 */
@ApiTags("tours")
@Controller("tours")
export class ToursController {
  constructor(private readonly service: ToursService) {}

  @Post("clusters")
  @ApiOperation({
    summary: "Discover top-N candidate clusters for the supplied filters",
  })
  @ApiResponse({ status: 201, description: "Candidate clusters, ranked." })
  async clusters(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<Tours.ClusterCandidatesResponse> {
    const parsed = Tours.PlanInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.discoverClusters(user.id, parsed.data);
  }

  @Post("walking-graph")
  @ApiOperation({
    summary:
      "Return the sparse walking graph (nodes + edges) the planner would build — for visual debugging.",
  })
  @ApiResponse({
    status: 201,
    description:
      "Pool caches as nodes, OSRM walking edges, plus suspicious-zero flags.",
  })
  async walkingGraph(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<Tours.WalkingGraphResponse> {
    const parsed = Tours.WalkingGraphInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.walkingGraph(user.id, parsed.data);
  }

  @Post("route/test")
  @ApiOperation({
    summary:
      "Live OSRM /route between two of the user's caches, bypassing the route_legs cache. Returns the actual polyline and meters/seconds, or a null route when OSRM reports NoRoute.",
  })
  @ApiResponse({ status: 201, description: "OSRM route or null." })
  async testRoute(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<Tours.TestRouteResponse> {
    const parsed = Tours.TestRouteInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.testOsrmRoute(user.id, parsed.data);
  }

  @Post("legs/via-route")
  @ApiOperation({
    summary:
      "Live OSRM foot-route `from → via → to` for the draggable via-point edit UI. Bypasses route_legs and is not persisted; the client throttles requests during drag.",
  })
  @ApiResponse({
    status: 201,
    description: "Via-routed leg, or null route when OSRM reports NoRoute.",
  })
  async viaRoute(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<Tours.ViaRouteResponse> {
    const parsed = Tours.ViaRouteInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.viaRoute(user.id, parsed.data);
  }

  @Post("walking-graph/purge-bogus")
  @ApiOperation({
    summary:
      "Destructive: delete suspicious zero-distance route_legs rows for caches in the search area, forcing a fresh OSRM refetch on the next planner pass.",
  })
  @ApiResponse({
    status: 201,
    description: "Count of route_legs rows deleted.",
  })
  async purgeBogusWalkingCells(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<Tours.PurgeBogusResponse> {
    const parsed = Tours.PurgeBogusInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.purgeBogusWalkingCells(user.id, parsed.data);
  }

  @Post("clusters/explain")
  @ApiOperation({
    summary:
      "Diagnose an arbitrary cache selection — per-strategy partitions, refinement projection, and algorithm attribution",
  })
  @ApiResponse({
    status: 201,
    description:
      "Selection geometry + per-cache + per-edge + per-strategy diagnostics.",
  })
  async explain(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<Tours.ExplainClusterResponse> {
    const parsed = Tours.ExplainClusterInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.explainSelection(user.id, parsed.data);
  }

  @Post("plan")
  @ApiOperation({
    summary:
      "Plan a routed closed loop on the supplied cache ids (a cluster picked from /tours/clusters)",
  })
  @ApiResponse({
    status: 201,
    description:
      "Ordered cache ids, polyline, totals, parking choice + score breakdown.",
  })
  async plan(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<Tours.PlanResult> {
    const parsed = Tours.PlanLoopInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.planLoop(user.id, parsed.data);
  }

  @Post("parking-options")
  @ApiOperation({
    summary:
      "For each parking waypoint near a cluster, return an OSRM-routed walk to the cluster's nearest cache. Powers the parking-preview map layer.",
  })
  @ApiResponse({
    status: 201,
    description:
      "Up to N parking options, each with its walking path + meters + seconds, sorted by walking distance ascending.",
  })
  async parkingOptions(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<Tours.ParkingOptionsResponse> {
    const parsed = Tours.ParkingOptionsInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.getParkingOptions(user.id, parsed.data);
  }
}
