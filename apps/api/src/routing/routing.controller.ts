// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Routing } from "@gctp/shared";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { RoutingService } from "./routing.service.js";

@ApiTags("routing")
@Controller("routing")
export class RoutingController {
  constructor(private readonly service: RoutingService) {}

  @Get("leg/:fromId/:toId")
  @ApiOperation({
    summary:
      "Walking leg between two caches owned by the current user. Cache-first; on miss calls OSRM and persists.",
  })
  @ApiQuery({
    name: "profile",
    required: false,
    enum: Routing.RoutingProfile.options,
  })
  @ApiResponse({
    status: 200,
    description: "Leg or null if OSRM couldn't route the pair.",
  })
  async leg(
    @CurrentUser() user: AuthUser,
    @Param("fromId", ParseIntPipe) fromId: number,
    @Param("toId", ParseIntPipe) toId: number,
    @Query("profile") profileRaw?: string,
  ): Promise<Routing.Leg | null> {
    const profile = parseProfile(profileRaw);
    return this.service.getLeg(user.id, fromId, toId, profile);
  }

  @Get("matrix")
  @ApiOperation({
    summary:
      "OD walking matrix for a list of cache IDs (all owned by the current user). One OSRM /table call covers missing pairs; cached pairs come from route_legs.",
  })
  @ApiQuery({
    name: "ids",
    required: true,
    isArray: true,
    type: Number,
    description: "Repeat the param per cache id, e.g. ?ids=1&ids=2&ids=3",
  })
  @ApiQuery({
    name: "profile",
    required: false,
    enum: Routing.RoutingProfile.options,
  })
  @ApiResponse({
    status: 200,
    description:
      "Symmetric (in practice — OSRM foot is mostly symmetric) matrix.",
  })
  async matrix(
    @CurrentUser() user: AuthUser,
    @Query("ids") idsRaw?: string | string[],
    @Query("profile") profileRaw?: string,
  ): Promise<Routing.Matrix> {
    if (!idsRaw)
      throw new BadRequestException("?ids is required (one or more)");
    const idsList = Array.isArray(idsRaw) ? idsRaw : [idsRaw];
    const ids = idsList.map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) {
        throw new BadRequestException(`?ids contains non-integer "${s}"`);
      }
      return n;
    });
    const profile = parseProfile(profileRaw);
    return this.service.getMatrix(user.id, ids, profile);
  }
}

function parseProfile(raw: string | undefined): Routing.RoutingProfile {
  const v = raw ?? "foot";
  const parsed = Routing.RoutingProfile.safeParse(v);
  if (!parsed.success) {
    throw new BadRequestException(
      `Unknown profile "${raw}" — supported: ${Routing.RoutingProfile.options.join(", ")}`,
    );
  }
  return parsed.data;
}
