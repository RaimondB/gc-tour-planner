// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";

@ApiTags("health")
@Controller("health")
export class HealthController {
  @Get()
  @ApiOperation({ summary: "Liveness probe" })
  @ApiResponse({ status: 200, description: "API process is up." })
  check(): { status: "ok"; uptime: number } {
    return { status: "ok", uptime: process.uptime() };
  }
}
