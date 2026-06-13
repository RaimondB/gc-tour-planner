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
  Patch,
  Post,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Tours } from "@gctp/shared";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { SavedToursService } from "./saved-tours.service.js";

/**
 * Saved-tour persistence (M6-γ, FR-P1/FR-P2). Distinct from the planning
 * surface on `ToursController` (also `/tours`, but only `/tours/{clusters,plan,…}`
 * sub-paths) — bare `POST/GET /tours` + `/tours/:id` belong here, so the two
 * controllers coexist on the same prefix without route conflicts.
 *
 * Every route is owner-scoped via `@CurrentUser()`; a cross-tenant id is a 404,
 * indistinguishable from "does not exist" (FR-P2.2). Sharing (`/tours/:id/share`,
 * public `/shared/:slug`) lands in M6-δ.
 */
@ApiTags("tours")
@Controller("tours")
export class SavedToursController {
  constructor(private readonly service: SavedToursService) {}

  @Post()
  @ApiOperation({ summary: "Save a planned tour (FR-P1)" })
  @ApiResponse({ status: 201, description: "The saved tour, full detail." })
  async save(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<Tours.SavedTourDetail> {
    const parsed = Tours.SaveTourInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.save(user.id, parsed.data);
  }

  @Get()
  @ApiOperation({ summary: "List the caller's saved tours (FR-P2.1)" })
  @ApiResponse({ status: 200, description: "Lean summaries, newest first." })
  async list(@CurrentUser() user: AuthUser): Promise<Tours.SavedTourSummary[]> {
    return this.service.list(user.id);
  }

  @Get(":id")
  @ApiOperation({ summary: "Open a saved tour in full detail (FR-P2.2)" })
  @ApiResponse({ status: 200, description: "Full tour incl. stored plan." })
  @ApiResponse({ status: 404, description: "Not found or not yours." })
  async getById(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
  ): Promise<Tours.SavedTourDetail> {
    return this.service.getById(user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Rename a saved tour (FR-P2.3)" })
  @ApiResponse({ status: 200, description: "The renamed tour." })
  @ApiResponse({ status: 404, description: "Not found or not yours." })
  async rename(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<Tours.SavedTourDetail> {
    const parsed = Tours.RenameTourInput.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.rename(user.id, id, parsed.data.name);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a saved tour (FR-P2.3)" })
  @ApiResponse({ status: 204, description: "Deleted." })
  @ApiResponse({ status: 404, description: "Not found or not yours." })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
  ): Promise<void> {
    await this.service.delete(user.id, id);
  }
}
