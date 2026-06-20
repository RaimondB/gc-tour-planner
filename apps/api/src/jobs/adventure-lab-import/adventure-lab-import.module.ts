// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { AdventureLabModule } from "../../sources/adventure-lab/adventure-lab.module.js";
import { CachesModule } from "../../caches/caches.module.js";
import { AdventureLabImportProcessor } from "./adventure-lab-import.processor.js";

/**
 * BullMQ processor registration for the `adventure-lab-import` queue (FR-I15).
 * Wired into AppModule; the worker runs in whatever process imports it (the api
 * container today, the jobs container under its own entrypoint).
 */
@Module({
  imports: [AdventureLabModule, CachesModule],
  providers: [AdventureLabImportProcessor],
})
export class AdventureLabImportModule {}
