// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Admin } from "@gctp/shared";
import { AdminGuard } from "../../auth/admin.guard.js";
import { AdminPrecomputeService } from "./admin-precompute.service.js";

/**
 * Admin surface for the upload-triggered precompute pipeline. Gated by the
 * global auth guard (session) plus `AdminGuard`: requires `users.is_admin`
 * (FR-P12), not merely a logged-in user.
 *
 * Backs both the custom `/admin/jobs` web page and ad-hoc curl during
 * incident response.
 */
@ApiTags("admin")
@UseGuards(AdminGuard)
@Controller("admin/precompute")
export class AdminPrecomputeController {
  constructor(private readonly service: AdminPrecomputeService) {}

  @Get("summary")
  @ApiOperation({
    summary: "Per-kind precompute freshness counts across the whole DB",
  })
  @ApiResponse({ status: 200, description: "Freshness summary." })
  async summary(): Promise<Admin.PrecomputeSummary> {
    return this.service.summary();
  }

  @Get("stale")
  @ApiOperation({
    summary: "Paginated list of stale caches for the given kind",
  })
  @ApiResponse({ status: 200, description: "Stale-cache list." })
  async stale(
    @Query("kind") kindParam: string,
    @Query("limit") limitParam?: string,
    @Query("offset") offsetParam?: string,
  ): Promise<Admin.StaleCacheListResponse> {
    const kind = Admin.PrecomputeKind.safeParse(kindParam);
    if (!kind.success) {
      throw new BadRequestException("kind must be 'walking'.");
    }
    const limit = clampInt(limitParam, 1, 500, 200);
    const offset = clampInt(offsetParam, 0, 1_000_000, 0);
    return this.service.listStale(kind.data, limit, offset);
  }

  @Post("retrigger-stale")
  @ApiOperation({
    summary: "Enqueue (re-)precompute for all currently-stale caches",
  })
  @ApiResponse({ status: 201, description: "Jobs enqueued." })
  async retriggerStale(
    @Body() body: unknown,
  ): Promise<Admin.RetriggerStaleResponse> {
    const parsed = Admin.RetriggerStaleRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.service.retriggerStale(parsed.data.kind);
  }

  @Get("adventure-labs")
  @ApiOperation({
    summary: "Walking-precompute health for Adventure Lab stages (FR-I20)",
  })
  @ApiResponse({
    status: 200,
    description: "AL stage walking-precompute counts.",
  })
  async adventureLabs(): Promise<Admin.AdventureLabWalkingStatus> {
    return this.service.adventureLabWalkingStatus();
  }

  @Post("adventure-labs/backfill")
  @ApiOperation({
    summary: "Backfill walking paths for Adventure Lab stages that lack them",
  })
  @ApiResponse({ status: 201, description: "Jobs enqueued." })
  async backfillAdventureLabs(): Promise<Admin.RetriggerStaleResponse> {
    return this.service.backfillAdventureLabWalking();
  }

  @Post("retrigger-one")
  @ApiOperation({
    summary: "Enqueue a single-cache retry from a failed-list row",
  })
  @ApiResponse({ status: 201, description: "Job enqueued." })
  async retriggerOne(@Body() body: unknown): Promise<{ jobId: string }> {
    const parsed = Admin.RetriggerOneRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    try {
      return await this.service.retriggerOne(
        parsed.data.cacheId,
        parsed.data.kind,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(message);
    }
  }
}

function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
