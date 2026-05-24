// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDb, type Database } from "@gctp/db";
import type { Kysely } from "kysely";
import { KYSELY } from "./database.tokens.js";

const kyselyProvider: Provider = {
  provide: KYSELY,
  useFactory: (config: ConfigService): Kysely<Database> => {
    const url = config.get<string>("DATABASE_URL");
    if (!url) {
      throw new Error("DATABASE_URL is not set. See infra/.env.example.");
    }
    return createDb({ url });
  },
  inject: [ConfigService],
};

@Module({
  providers: [kyselyProvider],
  exports: [KYSELY],
})
export class DatabaseModule {}
