// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module.js";
import { OsmModule } from "../../osm/osm.module.js";
import { PrecomputeStateModule } from "../../precompute-state/precompute-state.module.js";
import { CacheBboxRepository } from "./cache-bbox.repository.js";
import { OverpassRefreshProcessor } from "./overpass-refresh.processor.js";

@Module({
  imports: [DatabaseModule, OsmModule, PrecomputeStateModule],
  providers: [OverpassRefreshProcessor, CacheBboxRepository],
})
export class OverpassRefreshModule {}
