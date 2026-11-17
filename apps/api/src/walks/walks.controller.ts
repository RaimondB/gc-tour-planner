// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Walks } from "@gctp/shared";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { WalksService } from "./walks.service.js";

/** Replans per user per minute; keyed on the user, not the client IP. */
const WALK_THROTTLE = {
  default: {
    limit: 30,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) =>
      `walk:${(req.user as { id?: string } | undefined)?.id ?? "anon"}`,
  },
};

/**
 * Ad-hoc walk (ADR-0040, FR-T18). The body carries the walker's position and
 * return point; they're used for this request only — never stored, never
 * logged (ADR-0037 amendment).
 */
@ApiTags("walks")
@Controller("walks")
export class WalksController {
  constructor(private readonly service: WalksService) {}

  @Post("replan")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(WALK_THROTTLE)
  @ApiOperation({
    summary:
      "Replan an ad-hoc walk: a feasible route from here to the return point before the deadline",
  })
  @ApiResponse({ status: 200, description: "The tentative route + timing." })
  @ApiResponse({ status: 404, description: "Locked next cache isn't yours." })
  @ApiResponse({ status: 429, description: "Too many replans." })
  async replan(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<Walks.WalkReplanResult> {
    const parsed = Walks.WalkReplanInput.safeParse(body);
    if (!parsed.success) {
      // Never echo the input back: it contains the position.
      throw new BadRequestException("Invalid walk replan request");
    }
    return this.service.replan(user.id, parsed.data);
  }
}
