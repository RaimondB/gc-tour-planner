// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { BadRequestException, Injectable } from "@nestjs/common";
import { parseGpx, type ParsedGpx } from "@gctp/shared/gpx";
import { GpxRepository } from "./gpx.repository.js";

export interface GpxUploadResult {
  uploadId: string;
  cachesUpserted: number;
  waypointsInserted: number;
  warnings: string[];
}

@Injectable()
export class GpxService {
  constructor(private readonly repo: GpxRepository) {}

  async ingest(
    ownerId: string,
    filename: string,
    xml: string,
  ): Promise<GpxUploadResult> {
    let parsed: ParsedGpx;
    try {
      parsed = parseGpx(xml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.recordUpload(ownerId, filename, 0, "failed", message);
      throw new BadRequestException(`Failed to parse GPX: ${message}`);
    }

    const { insertedOrUpdated, waypointsInserted } =
      await this.repo.upsertFromGpx(ownerId, parsed.caches, parsed.waypoints);

    const uploadId = await this.repo.recordUpload(
      ownerId,
      filename,
      insertedOrUpdated,
      "parsed",
      null,
    );

    return {
      uploadId,
      cachesUpserted: insertedOrUpdated,
      waypointsInserted,
      warnings: parsed.warnings,
    };
  }
}
