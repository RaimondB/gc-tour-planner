// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { GpxService, type GpxUploadResult } from "./gpx.service.js";

/**
 * Hard cap on raw GPX upload size. PQ files scale roughly with cache
 * count × ~10-50 KB per cache (logs + attributes + waypoints), so a
 * 1000-cache PQ lands around 10-30 MB and a full "My Finds" can push
 * 40-60 MB. 64 MB covers realistic Groundspeak exports with headroom
 * and stays well within Nest's in-memory multer buffer comfort zone
 * on a 1 GB-capped api container.
 */
const MAX_GPX_BYTES = 64 * 1024 * 1024;

@ApiTags("gpx")
@Controller("gpx")
export class GpxController {
  constructor(private readonly service: GpxService) {}

  @Post("upload")
  @ApiOperation({
    summary: "Upload a Groundspeak Pocket Query (or generic) GPX file",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        markAsFound: {
          type: "string",
          enum: ["true", "false"],
          description:
            "Optional manual override. A Groundspeak 'My Finds' Pocket Query is auto-detected (top-level <name>My Finds Pocket Query</name>) and always marked found regardless of this flag. Set 'true' to also mark a regular PQ's caches as found.",
        },
        force: {
          type: "string",
          enum: ["true", "false"],
          description:
            "FR-I12 — bypass the duplicate-file skip. By default a byte-identical re-upload is detected and skipped (response has `duplicate: true`). Set 'true' to re-process the existing stored upload anyway (re-parse + re-upsert; no second copy stored).",
        },
        solvedCoordinates: {
          type: "string",
          enum: ["true", "false"],
          description:
            "Set 'true' when this GPX carries your SOLVED (corrected) coordinates. Groundspeak substitutes corrected coords into the primary <wpt> for caches you've solved with no machine-readable marker, so you assert it here. Every cache in the file is marked solved and its planning location set to the file's coords (Mystery solution or Multi final); the original posted coord is preserved and a normal PQ re-upload won't overwrite the solved location.",
        },
      },
      required: ["file"],
    },
  })
  @ApiResponse({
    status: 201,
    description:
      "GPX parsed and caches upserted. Returns the upload id, counts (caches, waypoints, finds), and any parser warnings.",
  })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_GPX_BYTES } }),
  )
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body("markAsFound") markAsFoundRaw?: string,
    @Body("force") forceRaw?: string,
    @Body("solvedCoordinates") solvedCoordinatesRaw?: string,
  ): Promise<GpxUploadResult> {
    if (!file)
      throw new BadRequestException('Multipart field "file" is required');
    const xml = file.buffer.toString("utf8");
    const markAsFound = markAsFoundRaw === "true" || markAsFoundRaw === "1";
    const force = forceRaw === "true" || forceRaw === "1";
    const solvedCoordinates =
      solvedCoordinatesRaw === "true" || solvedCoordinatesRaw === "1";
    return this.service.ingest(user.id, file.originalname, xml, {
      markAsFound,
      force,
      solvedCoordinates,
    });
  }
}
