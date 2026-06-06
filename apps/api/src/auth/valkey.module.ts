// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Global, Module, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import { VALKEY } from "./valkey.tokens.js";

const valkeyProvider: Provider = {
  provide: VALKEY,
  useFactory: (config: ConfigService): Redis => {
    const url = config.get<string>("VALKEY_URL");
    if (!url) {
      throw new Error(
        "VALKEY_URL is not set. See infra/.env.example. " +
          "Valkey backs auth sessions, the login limiter, and request throttling.",
      );
    }
    // ioredis accepts the redis:// URL form Valkey is configured with
    // (ADR-0004). lazyConnect keeps construction side-effect-free for tests
    // that never touch the client.
    return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
  },
  inject: [ConfigService],
};

/**
 * Provides the shared Valkey (ioredis) client app-wide. `@Global()` so the auth
 * session store, throttler storage, and per-email limiter can inject `VALKEY`
 * without re-importing this module.
 */
@Global()
@Module({
  providers: [valkeyProvider],
  exports: [VALKEY],
})
export class ValkeyModule {}
