// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { LanduseProfiles } from "@gctp/shared";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { LanduseProfilesRepository } from "./landuse-profiles.repository.js";

@ApiTags("landuse-profiles")
@Controller("landuse-profiles")
export class LanduseProfilesController {
  constructor(private readonly repo: LanduseProfilesRepository) {}

  @Get()
  @ApiOperation({
    summary:
      "List landuse-weighted scoring profiles visible to the caller (system + own). M5-β; per-user create/delete deferred.",
  })
  @ApiResponse({
    status: 200,
    description: "Profiles. System rows first, then user-owned by name.",
  })
  async list(
    @CurrentUser() user: AuthUser,
  ): Promise<LanduseProfiles.LanduseProfilesResponse> {
    const profiles = await this.repo.list(user.id);
    return { profiles };
  }
}
