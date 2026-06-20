// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import { MachineAuth } from "../auth/machine-auth.decorator.js";
import { GpxService, type GpxUploadResult } from "../gpx/gpx.service.js";
import { CurrentIngestActor, IngestAuthGuard } from "./ingest-auth.guard.js";
import type { IngestActor } from "./ingest-token-resolver.js";

/**
 * Hard cap on raw GPX size, matching the browser upload endpoint
 * (`gpx.controller.ts`). A 1000-cache PQ lands ~10-30 MB and a full "My Finds"
 * ~40-60 MB, so 64 MB covers realistic Groundspeak exports with headroom.
 */
const MAX_GPX_BYTES = 64 * 1024 * 1024;

/**
 * Machine ingestion API (FR-I14, ADR-0033). Lets a trusted non-browser client
 * (a script, a scheduled job, or an external source adapter) upload GPX cache
 * files with a bearer token instead of a browser session. Owner is the token's
 * actor, not a request-supplied id, so there is no on-behalf-of escape. The
 * heavy lifting (dedup, staleness guard, owner-scoped upsert, precompute) is the
 * existing GpxService, reused unchanged.
 */
@ApiTags("ingest")
@ApiSecurity("bearer")
@MachineAuth()
@UseGuards(IngestAuthGuard)
@Controller("ingest")
export class IngestController {
  constructor(private readonly gpx: GpxService) {}

  @Post("gpx")
  @ApiOperation({
    summary:
      "Machine ingestion of a Groundspeak Pocket Query (or generic) GPX file. Bearer-authenticated; caches are attributed to the token's owner.",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        markAsFound: { type: "string", enum: ["true", "false"] },
        force: { type: "string", enum: ["true", "false"] },
        solvedCoordinates: { type: "string", enum: ["true", "false"] },
      },
      required: ["file"],
    },
  })
  @ApiResponse({
    status: 201,
    description:
      "GPX parsed and caches upserted under the token owner. Returns the upload id, counts, and any parser warnings.",
  })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_GPX_BYTES } }),
  )
  async upload(
    @CurrentIngestActor() actor: IngestActor,
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
    return this.gpx.ingest(actor.ownerId, file.originalname, xml, {
      markAsFound,
      force,
      solvedCoordinates,
    });
  }
}
