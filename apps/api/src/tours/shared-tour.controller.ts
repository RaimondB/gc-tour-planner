// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Controller, Get, Param } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Tours } from "@gctp/shared";
import { Public } from "../auth/public.decorator.js";
import { SavedToursService } from "./saved-tours.service.js";

/**
 * Anonymous read-only shared-tour view (M6-δ / FR-P3.2, ADR-0022). The single
 * `@Public()` route here is part of the **normative** public-endpoint inventory
 * (FR-P11) — see `apps/api/src/auth/public-inventory.spec.ts`. It returns only
 * the safe snapshot subset (geometry, totals, cache list) and reads **no**
 * owner-scoped tables. Intentionally NOT rate-limited: an ~80-bit opaque slug is
 * not brute-forceable (ADR-0022 §6). On a separate `/shared` prefix so the
 * owner-scoped `/tours/:id` routes never collide with the public read.
 */
@ApiTags("tours")
@Controller("shared")
export class SharedTourController {
  constructor(private readonly service: SavedToursService) {}

  @Public()
  @Get(":slug")
  @ApiOperation({ summary: "Open a shared tour by its slug (public, FR-P3.2)" })
  @ApiResponse({ status: 200, description: "Read-only shared-tour snapshot." })
  @ApiResponse({ status: 404, description: "Unknown or revoked slug." })
  async getShared(@Param("slug") slug: string): Promise<Tours.SharedTour> {
    return this.service.getSharedBySlug(slug);
  }
}
