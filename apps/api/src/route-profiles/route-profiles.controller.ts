// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { RouteProfiles } from "@gctp/shared";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { RouteProfilesService } from "./route-profiles.service.js";

function parseBody(body: unknown): RouteProfiles.SaveRouteProfileInput {
  const parsed = RouteProfiles.SaveRouteProfileInput.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.flatten());
  }
  return parsed.data;
}

/**
 * Route profiles (FR-T19, ADR-0039): named planning presets. System presets
 * are listed but read-only; writes are owner-scoped and a system or foreign id
 * is a 404.
 */
@ApiTags("route-profiles")
@Controller("route-profiles")
export class RouteProfilesController {
  constructor(private readonly service: RouteProfilesService) {}

  @Get()
  @ApiOperation({ summary: "List route profiles (system presets + own)" })
  @ApiResponse({ status: 200, description: "System presets first, then own." })
  async list(
    @CurrentUser() user: AuthUser,
  ): Promise<RouteProfiles.RouteProfilesResponse> {
    return { profiles: await this.service.list(user.id) };
  }

  @Post()
  @ApiOperation({ summary: "Create a route profile" })
  @ApiResponse({ status: 201, description: "The created profile." })
  @ApiResponse({ status: 409, description: "Name already used by the caller." })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<RouteProfiles.RouteProfile> {
    return this.service.create(user.id, parseBody(body));
  }

  @Put(":id")
  @ApiOperation({ summary: "Replace one of the caller's route profiles" })
  @ApiResponse({ status: 200, description: "The updated profile." })
  @ApiResponse({ status: 404, description: "Not the caller's profile." })
  async update(
    @CurrentUser() user: AuthUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<RouteProfiles.RouteProfile> {
    return this.service.update(user.id, id, parseBody(body));
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete one of the caller's route profiles" })
  @ApiResponse({ status: 404, description: "Not the caller's profile." })
  async delete(
    @CurrentUser() user: AuthUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.service.delete(user.id, id);
  }
}
