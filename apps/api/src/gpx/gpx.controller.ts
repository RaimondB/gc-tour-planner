// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
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

const MAX_GPX_BYTES = 10 * 1024 * 1024; // 10 MB hard cap; larger files queue in M4+

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
      properties: { file: { type: "string", format: "binary" } },
      required: ["file"],
    },
  })
  @ApiResponse({
    status: 201,
    description:
      "GPX parsed and caches upserted. Returns the upload id, the count of caches and waypoints written, and any parser warnings.",
  })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_GPX_BYTES } }),
  )
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<GpxUploadResult> {
    if (!file)
      throw new BadRequestException('Multipart field "file" is required');
    const xml = file.buffer.toString("utf8");
    return this.service.ingest(user.id, file.originalname, xml);
  }
}
