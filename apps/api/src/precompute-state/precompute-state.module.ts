// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { PrecomputeStateRepository } from "./precompute-state.repository.js";

@Module({
  imports: [DatabaseModule],
  providers: [PrecomputeStateRepository],
  exports: [PrecomputeStateRepository],
})
export class PrecomputeStateModule {}
