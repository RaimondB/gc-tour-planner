// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { CachesModule } from "../../caches/caches.module.js";
import { DatabaseModule } from "../../database/database.module.js";
import { PrecomputeStateModule } from "../../precompute-state/precompute-state.module.js";
import { RoutingModule } from "../../routing/routing.module.js";
import { AffectedSetRepository } from "./affected-set.repository.js";
import { WalkingPrecomputeProcessor } from "./walking-precompute.processor.js";

/**
 * BullMQ processor registration for the `walking-precompute` queue.
 * Wired into AppModule; the worker runs in any process that imports it
 * (the api container today; the jobs container once Dockerfile.jobs runs
 * the real entrypoint).
 */
@Module({
  imports: [DatabaseModule, CachesModule, RoutingModule, PrecomputeStateModule],
  providers: [WalkingPrecomputeProcessor, AffectedSetRepository],
})
export class WalkingPrecomputeModule {}
