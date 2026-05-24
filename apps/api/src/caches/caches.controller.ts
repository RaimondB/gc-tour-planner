// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Caches } from "@gctp/shared";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { CachesService } from "./caches.service.js";

/**
 * Query-string shape for GET /caches:
 *
 *   ?lng=5.12&lat=52.09&radiusM=5000
 *   &types=Traditional&types=Multi
 *   &attributes=[[{"id":24,"positive":true}]]   // JSON-encoded AND-of-OR
 *   &excludeFound=true
 *
 * `attributes` carries structured data, so JSON encoding is the least painful
 * choice that survives a GET. Switch to POST if a real-world request ever hits
 * the URL-length limit.
 */
@ApiTags("caches")
@Controller("caches")
export class CachesController {
  constructor(private readonly service: CachesService) {}

  @Get()
  @ApiOperation({
    summary: "List caches in a radius matching the supplied hard filters",
  })
  @ApiQuery({ name: "lng", required: true, type: Number })
  @ApiQuery({ name: "lat", required: true, type: Number })
  @ApiQuery({
    name: "radiusM",
    required: true,
    type: Number,
    description: "Max 50 000",
  })
  @ApiQuery({ name: "types", required: false, isArray: true, type: String })
  @ApiQuery({
    name: "attributes",
    required: false,
    type: String,
    description: "JSON-encoded AND-of-OR attribute filter groups",
  })
  @ApiQuery({
    name: "excludeFound",
    required: false,
    type: Boolean,
    description: "When true, omit caches the current user has logged as found",
  })
  @ApiResponse({
    status: 200,
    description: "Caches plus a coarse grid clusterHint.",
  })
  async list(
    @CurrentUser() user: AuthUser,
    @Query("lng") lng?: string,
    @Query("lat") lat?: string,
    @Query("radiusM") radiusM?: string,
    @Query("types") typesRaw?: string | string[],
    @Query("attributes") attributesRaw?: string,
    @Query("excludeFound") excludeFoundRaw?: string,
  ): Promise<Caches.CachesResponse> {
    const types =
      typesRaw === undefined
        ? undefined
        : Array.isArray(typesRaw)
          ? typesRaw
          : [typesRaw];
    let attributes: unknown;
    if (attributesRaw !== undefined && attributesRaw !== "") {
      try {
        attributes = JSON.parse(attributesRaw);
      } catch {
        throw new BadRequestException(`?attributes is not valid JSON`);
      }
    }
    const excludeFound = excludeFoundRaw === "true" || excludeFoundRaw === "1";

    const parsed = Caches.CachesQuery.safeParse({
      center: [Number(lng), Number(lat)],
      radiusM: radiusM === undefined ? undefined : Number(radiusM),
      types,
      attributes,
      excludeFound,
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.service.list(user.id, parsed.data);
  }

  @Post(":id/finds")
  @ApiOperation({
    summary: "Mark a cache as found by the current user (idempotent)",
  })
  @ApiResponse({
    status: 201,
    description:
      "Mark applied. `created: true` if it was new, `false` if already marked.",
  })
  markFound(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<{ created: boolean }> {
    return this.service.markFound(user.id, id);
  }

  @Delete(":id/finds")
  @ApiOperation({ summary: "Remove the current user's find for a cache" })
  @ApiResponse({
    status: 200,
    description:
      "Unmark applied. `removed: true` if a row was deleted, `false` if none existed.",
  })
  unmarkFound(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<{ removed: boolean }> {
    return this.service.unmarkFound(user.id, id);
  }
}
