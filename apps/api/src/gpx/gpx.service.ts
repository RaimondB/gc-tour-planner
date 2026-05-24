// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { BadRequestException, Injectable } from "@nestjs/common";
import { parseGpx, type ParsedGpx } from "@gctp/shared/gpx";
import { GpxRepository } from "./gpx.repository.js";

export interface GpxUploadResult {
  uploadId: string;
  cachesUpserted: number;
  waypointsInserted: number;
  findsRecorded: number;
  warnings: string[];
}

export interface IngestOptions {
  /**
   * When true, every cache in the upload is also marked as found by the
   * uploader (idempotent — existing finds aren't disturbed). Intended for
   * Groundspeak "My Finds" Pocket Queries.
   */
  markAsFound?: boolean;
}

@Injectable()
export class GpxService {
  constructor(private readonly repo: GpxRepository) {}

  async ingest(
    ownerId: string,
    filename: string,
    xml: string,
    opts: IngestOptions = {},
  ): Promise<GpxUploadResult> {
    let parsed: ParsedGpx;
    try {
      parsed = parseGpx(xml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.recordUpload(ownerId, filename, 0, "failed", message);
      throw new BadRequestException(`Failed to parse GPX: ${message}`);
    }

    const { insertedOrUpdated, waypointsInserted, cacheIdByCode } =
      await this.repo.upsertFromGpx(ownerId, parsed.caches, parsed.waypoints);

    let findsRecorded = 0;
    if (opts.markAsFound && cacheIdByCode.size > 0) {
      findsRecorded = await this.repo.recordFinds(
        ownerId,
        Array.from(cacheIdByCode.values()),
        "gpx-finds-import",
      );
    }

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
      findsRecorded,
      warnings: parsed.warnings,
    };
  }
}
