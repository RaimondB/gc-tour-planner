// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Body, Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../auth/current-user.decorator.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { GpxService, type GpxUploadResult } from "../../gpx/gpx.service.js";

/**
 * Admin surface for re-running the GPX parser against a previously
 * uploaded file (kept on disk under `UPLOADS_DIR`). Use after the
 * parser learns about a new field — e.g. once `disabled` parsing
 * lands, reprocessing yesterday's PQs back-fills the column without
 * asking the user to re-upload.
 *
 * Gated by the existing dev-user middleware today; will need a real
 * admin role check when M6 auth lands. Per-owner: the service rejects
 * cross-tenant ids with a 404 (indistinguishable from "doesn't exist"
 * to keep id probing useless).
 */
@ApiTags("admin")
@Controller("admin/uploads")
export class AdminUploadsController {
  constructor(private readonly gpx: GpxService) {}

  @Post(":id/reprocess")
  @ApiOperation({
    summary:
      "Re-parse the stored raw GPX for this upload and re-upsert. Used after the parser learns about a new field.",
  })
  @ApiResponse({
    status: 201,
    description:
      "Same shape as POST /gpx/upload — upload id + counts + warnings.",
  })
  async reprocess(
    @CurrentUser() user: AuthUser,
    @Param("id", new ParseUUIDPipe()) uploadId: string,
    @Body() body: { markAsFound?: boolean } | undefined,
  ): Promise<GpxUploadResult> {
    return this.gpx.reprocess(user.id, uploadId, {
      markAsFound: body?.markAsFound === true,
    });
  }
}
