// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Public } from "../auth/public.decorator.js";

@ApiTags("health")
@Controller("health")
export class HealthController {
  // Liveness probe must answer without a session — it's in the public-endpoint
  // inventory (FR-P11). Keep this @Public() in sync with that table + its test.
  @Public()
  @Get()
  @ApiOperation({ summary: "Liveness probe" })
  @ApiResponse({ status: 200, description: "API process is up." })
  check(): { status: "ok"; uptime: number } {
    return { status: "ok", uptime: process.uptime() };
  }
}
