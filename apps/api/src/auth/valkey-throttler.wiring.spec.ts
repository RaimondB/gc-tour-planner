// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ValkeyModule } from "./valkey.module.js";
import { ValkeyThrottlerStorage } from "./valkey-throttler.storage.js";

/**
 * DI-wiring regression guard for the throttler storage.
 *
 * `ThrottlerModule.forRootAsync()` resolves its `inject` tokens in its OWN
 * module scope — not the importing module's. A previous wiring declared
 * `ValkeyThrottlerStorage` in AppModule's `providers` (exported by no module),
 * so the dynamic ThrottlerModule could not see it: NestFactory aborted at boot
 * with `UnknownDependenciesException` on `THROTTLER:MODULE_OPTIONS`, the HTTP
 * port never bound, and every `/api/*` route 502'd at the dev proxy.
 *
 * This mirrors AppModule's throttler block exactly. It needs no live Valkey:
 * the client is `lazyConnect` and `ValkeyThrottlerStorage`'s constructor only
 * stores the injected handle. The fix makes the `@Global` ValkeyModule EXPORT
 * the storage — that export is what makes it resolvable in the dynamic
 * ThrottlerModule's scope (the `imports: [ValkeyModule]` below is then
 * belt-and-suspenders, kept to mirror AppModule). Drop the export and
 * `compile()` throws the original boot-time error right here.
 */
describe("throttler storage DI wiring", () => {
  const prev = process.env.VALKEY_URL;

  beforeAll(() => {
    // ValkeyModule's factory throws without this; lazyConnect means no socket.
    process.env.VALKEY_URL = "redis://localhost:6379";
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.VALKEY_URL;
    else process.env.VALKEY_URL = prev;
  });

  it("resolves ValkeyThrottlerStorage inside the ThrottlerModule scope", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ValkeyModule,
        ThrottlerModule.forRootAsync({
          imports: [ValkeyModule],
          inject: [ValkeyThrottlerStorage],
          useFactory: (storage: ValkeyThrottlerStorage) => ({
            throttlers: [{ name: "default", ttl: 60_000, limit: 60 }],
            storage,
          }),
        }),
      ],
    }).compile();

    expect(moduleRef.get(ValkeyThrottlerStorage)).toBeInstanceOf(
      ValkeyThrottlerStorage,
    );

    await moduleRef.close();
  });
});
