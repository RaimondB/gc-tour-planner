// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { AdventureLabModule } from "../sources/adventure-lab/adventure-lab.module.js";
import { AdventureLabsController } from "./adventure-labs.controller.js";
import { AdventureLabsService } from "./adventure-labs.service.js";

/**
 * User-facing Adventure Lab sync (FR-I19) — the "Sync this area" button. The
 * BullMQ queue is global (QueueModule); AdventureLabModule supplies the resolved
 * enrichment config (the enabled flag the enqueue path checks).
 */
@Module({
  imports: [AdventureLabModule],
  controllers: [AdventureLabsController],
  providers: [AdventureLabsService],
})
export class AdventureLabsModule {}
