// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AdventureLabs } from "@gctp/shared";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { AdventureLabsService } from "./adventure-labs.service.js";

/**
 * User-facing Adventure Lab sync (FR-I19). Authenticated by the global guard
 * (session) — not admin-gated; a user syncs Adventure Labs in the area they're
 * looking at, refreshing AL data and crossing off their completed stages.
 */
@ApiTags("adventure-labs")
@Controller("adventure-labs")
export class AdventureLabsController {
  constructor(private readonly service: AdventureLabsService) {}

  @Post("sync")
  @ApiOperation({
    summary:
      "Sync Adventure Labs in an area (background job); returns a job id",
  })
  @ApiResponse({
    status: 201,
    description: "Job enqueued; returns the job id.",
  })
  @ApiResponse({ status: 400, description: "Invalid area, or sync disabled." })
  async sync(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<AdventureLabs.AdventureLabSyncResponse> {
    const parsed = AdventureLabs.AdventureLabSyncRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.service.enqueueSync(user.id, parsed.data);
  }

  @Get("sync/:jobId")
  @ApiOperation({ summary: "Progress of a sync job (poll while it runs)" })
  @ApiResponse({ status: 200, description: "Current sync status." })
  @ApiResponse({ status: 404, description: "No such job for this user." })
  async syncStatus(
    @CurrentUser() user: AuthUser,
    @Param("jobId") jobId: string,
  ): Promise<AdventureLabs.AdventureLabSyncStatus> {
    return this.service.getSyncStatus(user.id, jobId);
  }
}
