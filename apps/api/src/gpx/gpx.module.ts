// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { GpxController } from "./gpx.controller.js";
import { GpxRepository } from "./gpx.repository.js";
import { GpxService } from "./gpx.service.js";
import { GpxStorageService, UPLOADS_DIR } from "./gpx-storage.service.js";

/**
 * `UPLOADS_DIR` is bound from env at module construction. In the docker
 * compose stacks (dev + uat + prod) the api container mounts the
 * `gctp_uploads` named volume at `/srv/uploads`; in dev-on-host
 * `scripts/dev.sh` points it at `./data/uploads/` on the developer's
 * filesystem. Throws on boot if unset — we don't want a silent fallback
 * to a tmp dir that disappears across restarts.
 */
function resolveUploadsDir(): string {
  const v = process.env.UPLOADS_DIR;
  if (!v || v.trim() === "") {
    throw new Error(
      "UPLOADS_DIR env var is required. " +
        "In docker compose this is set to /srv/uploads with the gctp_uploads volume; " +
        "in dev (scripts/dev.sh) it defaults to ./data/uploads.",
    );
  }
  return v;
}

@Module({
  imports: [DatabaseModule],
  controllers: [GpxController],
  providers: [
    GpxService,
    GpxRepository,
    GpxStorageService,
    { provide: UPLOADS_DIR, useFactory: resolveUploadsDir },
  ],
  exports: [GpxService, GpxStorageService],
})
export class GpxModule {}
