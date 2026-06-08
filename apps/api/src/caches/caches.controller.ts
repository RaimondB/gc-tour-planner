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
  @ApiQuery({
    name: "contexts",
    required: false,
    isArray: true,
    type: String,
    description:
      "Hard-filter on OSM landuse kinds; cache must lie inside at least one cached polygon of the requested kinds. Warm /landuse for the same bbox first.",
  })
  @ApiQuery({
    name: "includeDisabled",
    required: false,
    type: Boolean,
    description:
      "When true, include caches the owner has temporarily disabled (FR-I10). Default false — these are hidden.",
  })
  @ApiQuery({
    name: "includeArchived",
    required: false,
    type: Boolean,
    description:
      "When true, include archived caches (FR-I10). Default false. No UI today; reserved for debug.",
  })
  @ApiQuery({
    name: "solvedMysteriesOnly",
    required: false,
    type: Boolean,
    description:
      "When true, exclude Mystery caches without a solved coordinate. Other types unaffected.",
  })
  @ApiQuery({
    name: "multiSubtype",
    required: false,
    enum: ["all", "field-puzzle", "mini", "full"],
    description:
      "FR-SF2 Multi sub-type filter. 'all'/omitted = no narrowing; otherwise keep only Multis whose stage count classifies as the given bucket.",
  })
  @ApiQuery({
    name: "hideToolCaches",
    required: false,
    type: Boolean,
    description: "FR-SF6 — hide caches that require special equipment.",
  })
  @ApiResponse({
    status: 200,
    description:
      "Lean per-cache summaries (CacheSummaryDTO) plus a coarse grid clusterHint. Popup-only fields (difficulty, terrain, attributes, hints) are fetched per cache via GET /caches/:id.",
  })
  async list(
    @CurrentUser() user: AuthUser,
    @Query("lng") lng?: string,
    @Query("lat") lat?: string,
    @Query("radiusM") radiusM?: string,
    @Query("types") typesRaw?: string | string[],
    @Query("attributes") attributesRaw?: string,
    @Query("excludeFound") excludeFoundRaw?: string,
    @Query("contexts") contextsRaw?: string | string[],
    @Query("includeDisabled") includeDisabledRaw?: string,
    @Query("includeArchived") includeArchivedRaw?: string,
    @Query("solvedMysteriesOnly") solvedMysteriesOnlyRaw?: string,
    @Query("multiSubtype") multiSubtypeRaw?: string,
    @Query("hideToolCaches") hideToolCachesRaw?: string,
  ): Promise<Caches.CachesSummaryResponse> {
    const types =
      typesRaw === undefined
        ? undefined
        : Array.isArray(typesRaw)
          ? typesRaw
          : [typesRaw];
    const contexts =
      contextsRaw === undefined
        ? undefined
        : Array.isArray(contextsRaw)
          ? contextsRaw
          : [contextsRaw];
    let attributes: unknown;
    if (attributesRaw !== undefined && attributesRaw !== "") {
      try {
        attributes = JSON.parse(attributesRaw);
      } catch {
        throw new BadRequestException(`?attributes is not valid JSON`);
      }
    }
    const excludeFound = excludeFoundRaw === "true" || excludeFoundRaw === "1";
    const includeDisabled =
      includeDisabledRaw === "true" || includeDisabledRaw === "1";
    const includeArchived =
      includeArchivedRaw === "true" || includeArchivedRaw === "1";
    const solvedMysteriesOnly =
      solvedMysteriesOnlyRaw === "true" || solvedMysteriesOnlyRaw === "1";
    const hideToolCaches =
      hideToolCachesRaw === "true" || hideToolCachesRaw === "1";

    const parsed = Caches.CachesQuery.safeParse({
      center: [Number(lng), Number(lat)],
      radiusM: radiusM === undefined ? undefined : Number(radiusM),
      types,
      attributes,
      excludeFound,
      contexts,
      includeDisabled,
      includeArchived,
      solvedMysteriesOnly,
      // "all"/undefined both mean "no narrowing"; let zod reject anything else.
      multiSubtype:
        multiSubtypeRaw === undefined || multiSubtypeRaw === ""
          ? undefined
          : multiSubtypeRaw,
      hideToolCaches,
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    // Map the full internal result down to the lean wire shape. The DB work
    // (and internal planner callers of service.list) keep the full DTO; only
    // the network response is slimmed. Popup-only fields come from /caches/:id.
    const full = await this.service.list(user.id, parsed.data);
    return {
      caches: full.caches.map(Caches.toCacheSummary),
      clustersHint: full.clustersHint,
    };
  }

  @Get(":id")
  @ApiOperation({
    summary: "Full detail for one cache (the popup-only fields /caches omits)",
  })
  @ApiResponse({ status: 200, description: "The full CacheDTO." })
  @ApiResponse({
    status: 404,
    description: "No such cache for the current user.",
  })
  detail(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<Caches.CacheDTO> {
    return this.service.getDetail(user.id, id);
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

  @Delete(":id/solved-coordinates")
  @ApiOperation({
    summary:
      "Remove a cache's solved coordinate, reverting its planning location to the posted coord",
  })
  @ApiResponse({
    status: 200,
    description:
      "Solved coordinate removed. `cleared: true` if the cache was solved (location reverted, precompute re-warmed), `false` if it had none.",
  })
  @ApiResponse({
    status: 404,
    description: "No such cache for the current user.",
  })
  clearSolved(
    @CurrentUser() user: AuthUser,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<{ cleared: boolean }> {
    return this.service.clearSolved(user.id, id);
  }
}
