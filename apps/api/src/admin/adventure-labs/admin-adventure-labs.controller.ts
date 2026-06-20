// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Admin } from "@gctp/shared";
import { AdminGuard } from "../../auth/admin.guard.js";
import { CurrentUser } from "../../auth/current-user.decorator.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { AdminAdventureLabsService } from "./admin-adventure-labs.service.js";

/**
 * Admin surface for the bulk Adventure Lab import (FR-I15). Gated by the global
 * auth guard (session) plus `AdminGuard` (requires `users.is_admin`). The heavy
 * whole-area Lab2Gpx fetch runs as a background job; this just enqueues it.
 */
@ApiTags("admin")
@UseGuards(AdminGuard)
@Controller("admin/adventure-labs")
export class AdminAdventureLabsController {
  constructor(private readonly service: AdminAdventureLabsService) {}

  @Post("import")
  @ApiOperation({
    summary: "Enqueue a bulk Adventure Lab import for an area (background job)",
  })
  @ApiResponse({
    status: 201,
    description: "Job enqueued; returns the job id.",
  })
  async import(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<Admin.AdventureLabImportResponse> {
    const parsed = Admin.AdventureLabImportRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.enqueueImport(user.id, parsed.data);
  }

  @Post("backfill-ids")
  @ApiOperation({
    summary:
      "Backfill missing Adventure Lab adventure_id from Lab2Gpx (background job)",
  })
  @ApiResponse({
    status: 201,
    description: "Job enqueued; returns the job id.",
  })
  async backfillIds(
    @CurrentUser() user: AuthUser,
  ): Promise<Admin.AdventureLabImportResponse> {
    return this.service.enqueueBackfill(user.id);
  }
}
