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
  Put,
  Req,
  Res,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { Tours } from "@gctp/shared";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { SavedToursService } from "./saved-tours.service.js";

/** Max accepted map-snapshot size. WebP at ~modest quality is tens of KB. */
const MAX_PREVIEW_BYTES = 512 * 1024;
/** Only WebP is accepted — what the web client captures via toDataURL. */
const PREVIEW_MIME = "image/webp";

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

  @Put(":id/preview")
  @HttpCode(204)
  @ApiOperation({
    summary: "Store the tour's map snapshot (FR-W4)",
    description:
      "Body is a raw image/webp captured client-side. Shown offline and as the list thumbnail.",
  })
  @ApiResponse({ status: 204, description: "Snapshot stored." })
  @ApiResponse({ status: 400, description: "Missing/too large/wrong type." })
  @ApiResponse({ status: 404, description: "Not found or not yours." })
  async putPreview(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Req() req: Request,
  ): Promise<void> {
    // `express.raw({ type: "image/webp" })` (registered in main.ts) buffers the
    // body only for that content-type; any other type leaves a non-Buffer here.
    // The explicit `Array.isArray` rejection closes the parameter-tampering
    // size-check bypass CodeQL flags (js/type-confusion-through-parameter-
    // tampering): an array's `.length` is its element count, which could slip
    // past the byte-size guard below.
    const raw: unknown = req.body;
    if (Array.isArray(raw) || !Buffer.isBuffer(raw)) {
      throw new BadRequestException(`Expected a ${PREVIEW_MIME} body`);
    }
    if (raw.length === 0) {
      throw new BadRequestException(
        `Expected a non-empty ${PREVIEW_MIME} body`,
      );
    }
    if (raw.length > MAX_PREVIEW_BYTES) {
      throw new BadRequestException("Snapshot too large");
    }
    await this.service.savePreview(user.id, id, raw, PREVIEW_MIME);
  }

  @Get(":id/preview")
  @ApiOperation({ summary: "Fetch the tour's map snapshot (FR-W4)" })
  @ApiResponse({ status: 200, description: "The image/webp snapshot." })
  @ApiResponse({ status: 404, description: "No snapshot, or not yours." })
  async getPreview(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Res() res: Response,
  ): Promise<void> {
    const preview = await this.service.getPreview(user.id, id);
    res.setHeader("Content-Type", preview.mime);
    // Private (owner-only) data — the service worker still caches it per-client
    // for offline viewing; the browser may revalidate within a short window.
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(preview.image);
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
