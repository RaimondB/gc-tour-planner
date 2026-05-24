// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { CacheLanduseRepository } from "./cache-landuse.repository.js";
import { CachesController } from "./caches.controller.js";
import { CachesRepository } from "./caches.repository.js";
import { CachesService } from "./caches.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [CachesController],
  providers: [CachesService, CachesRepository, CacheLanduseRepository],
  exports: [CachesService, CachesRepository, CacheLanduseRepository],
})
export class CachesModule {}
