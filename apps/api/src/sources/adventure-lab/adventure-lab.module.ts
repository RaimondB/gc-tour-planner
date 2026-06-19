// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { GpxModule } from "../../gpx/gpx.module.js";
import { adventureLabConfigProvider } from "./al.config.js";
import { AdventureLabEnricher } from "./al-enricher.service.js";

/**
 * Server-side Adventure Lab cluster enrichment (Phase 2). Imports GpxModule to
 * reuse the GPX ingest path; exports the enricher for ToursService to call
 * before Pass-1 clustering.
 */
@Module({
  imports: [GpxModule],
  providers: [adventureLabConfigProvider, AdventureLabEnricher],
  exports: [AdventureLabEnricher],
})
export class AdventureLabModule {}
