// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { AdventureLabModule } from "../../sources/adventure-lab/adventure-lab.module.js";
import { AdminAdventureLabsController } from "./admin-adventure-labs.controller.js";
import { AdminAdventureLabsService } from "./admin-adventure-labs.service.js";

/**
 * Producer side of the bulk Adventure Lab import. Imports AdventureLabModule for
 * the ADVENTURE_LAB_CONFIG token (to refuse enqueue when the flag is off); the
 * QUEUE_ADVENTURE_LAB_IMPORT queue is provided globally by QueueModule.
 */
@Module({
  imports: [AdventureLabModule],
  controllers: [AdminAdventureLabsController],
  providers: [AdminAdventureLabsService],
})
export class AdminAdventureLabsModule {}
