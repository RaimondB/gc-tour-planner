// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Database } from "@gctp/db";
import type { Admin } from "@gctp/shared";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../../database/database.tokens.js";
import { LanduseRepository } from "../../osm/landuse.repository.js";

/**
 * Admin surface for the osm2pgsql-fed landuse pipeline (ADR-0009 +
 * ADR-0010 simplification).
 *
 * `GET /admin/landuse/status` — current import health. Refreshes happen
 * out-of-band via the `scripts/refresh-osm-data.sh` host script (which
 * the operator runs on a schedule), not from an admin button — keeping
 * landuse + OSRM updates strictly in lockstep avoids data drift between
 * the two halves of the geo stack.
 */
@Injectable()
export class AdminLanduseService {
  private readonly logger = new Logger(AdminLanduseService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly landuse: LanduseRepository,
  ) {}

  async status(): Promise<Admin.LanduseStatus> {
    const [meta, countRow] = await Promise.all([
      this.landuse.lastImportMeta(),
      sql<{ n: string }>`SELECT count(*)::text AS n FROM landuse_polygons`.execute(
        this.db,
      ),
    ]);
    const polygonCount = Number(countRow.rows[0]?.n ?? 0);
    return {
      importedAt: meta?.importedAt ? meta.importedAt.toISOString() : null,
      pbfTimestamp: meta?.pbfTimestamp ? meta.pbfTimestamp.toISOString() : null,
      sourceFile: meta?.sourceFile ?? null,
      replicatedAt: meta?.replicatedAt ? meta.replicatedAt.toISOString() : null,
      replicationState: meta?.replicationState ?? null,
      polygonCount,
    };
  }

}
