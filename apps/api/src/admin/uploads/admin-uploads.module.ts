// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { GpxModule } from "../../gpx/gpx.module.js";
import { AdminUploadsController } from "./admin-uploads.controller.js";

@Module({
  imports: [GpxModule],
  controllers: [AdminUploadsController],
})
export class AdminUploadsModule {}
