// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { Database } from "@gctp/db";
import { type Kysely } from "kysely";
import { DatabaseModule } from "../database/database.module.js";
import { KYSELY } from "../database/database.tokens.js";
import { GpxModule } from "../gpx/gpx.module.js";
import { IngestController } from "./ingest.controller.js";
import {
  INGEST_CONFIG,
  ingestConfigProvider,
  type IngestConfig,
} from "./ingest.config.js";
import {
  EnvIngestTokenResolver,
  INGEST_TOKEN_RESOLVER,
} from "./ingest-token-resolver.js";

/**
 * Soft startup check: a misconfigured `INGEST_OWNER_ID` would silently ingest
 * to a non-existent owner. We warn (not throw) so a transient DB hiccup at boot
 * doesn't take the app down, but a wrong id is loud in the logs.
 */
@Injectable()
class IngestOwnerCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(IngestOwnerCheck.name);

  constructor(
    @Inject(INGEST_CONFIG) private readonly cfg: IngestConfig,
    @Inject(KYSELY) private readonly db: Kysely<Database>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.enabled || !this.cfg.ownerId) return;
    const row = await this.db
      .selectFrom("users")
      .select("id")
      .where("id", "=", this.cfg.ownerId)
      .executeTakeFirst();
    if (!row) {
      this.logger.warn(
        `INGEST_OWNER_ID=${this.cfg.ownerId} is not an existing user. ` +
          "Machine-ingested caches would be attributed to a non-existent owner.",
      );
    }
  }
}

/**
 * Machine ingestion API (FR-I14, ADR-0033). Reuses GpxService for the actual
 * ingest; adds only the bearer-auth surface for external source adapters.
 */
@Module({
  imports: [DatabaseModule, GpxModule],
  controllers: [IngestController],
  providers: [
    ingestConfigProvider,
    { provide: INGEST_TOKEN_RESOLVER, useClass: EnvIngestTokenResolver },
    IngestOwnerCheck,
  ],
})
export class IngestModule {}
