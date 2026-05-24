// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { GpxController } from "./gpx.controller.js";
import { GpxRepository } from "./gpx.repository.js";
import { GpxService } from "./gpx.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [GpxController],
  providers: [GpxService, GpxRepository],
})
export class GpxModule {}
