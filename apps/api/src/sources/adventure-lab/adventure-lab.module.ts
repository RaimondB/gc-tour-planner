// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module.js";
import { CachesModule } from "../../caches/caches.module.js";
import { GpxModule } from "../../gpx/gpx.module.js";
import {
  ADVENTURE_LAB_CONFIG,
  adventureLabConfigProvider,
} from "./al.config.js";
import { AdventureLabEnricher } from "./al-enricher.service.js";

/**
 * Server-side Adventure Lab enrichment (FR-I15). Imports GpxModule to reuse the
 * GPX ingest path; exports the enricher (cluster-augment + bulk-import worker)
 * and the resolved config token (the admin producer checks the flag before
 * enqueueing).
 */
@Module({
  imports: [GpxModule, CachesModule, AuthModule],
  providers: [adventureLabConfigProvider, AdventureLabEnricher],
  exports: [AdventureLabEnricher, ADVENTURE_LAB_CONFIG],
})
export class AdventureLabModule {}
