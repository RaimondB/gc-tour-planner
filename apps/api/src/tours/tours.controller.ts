// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Tours } from "@gctp/shared";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { ToursService } from "./tours.service.js";

/**
 * Two-pass tour-planning surface (see ADR-0002):
 *   POST /tours/clusters  — Pass 1: candidate clusters with score breakdown.
 *   POST /tours/plan      — Pass 2: routed closed loop on chosen cache ids.
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
}
