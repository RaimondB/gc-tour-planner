// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseModule } from "../database/database.module.js";
import { KYSELY } from "../database/database.tokens.js";
import { CachesRepository } from "../caches/caches.repository.js";
import { SavedToursRepository } from "./saved-tours.repository.js";
import { SavedToursService } from "./saved-tours.service.js";

/**
 * DI-wiring regression guard for the saved-tours persistence layer.
 *
 * `SavedToursRepository` is declared in `ToursModule`'s `providers` and
 * `@Inject(KYSELY)`s the Kysely handle — and so does the `CachesRepository`
 * the service composes. The other repos in `ToursModule` arrive pre-constructed
 * from their own modules, so until this slice `ToursModule` never needed
 * `KYSELY` in its own scope: the first wiring omitted `DatabaseModule` from its
 * imports, `KYSELY` was unresolvable, and `NestFactory` aborted at boot with
 * `UnknownDependenciesException` (the HTTP port never bound; every `/api/*`
 * route failed). The fix is `ToursModule imports: [DatabaseModule, …]`.
 *
 * This compiles the same provider slice against the REAL `DatabaseModule`
 * (KYSELY factory overridden so nothing connects), so the constructor-injection
 * contract — these repositories resolve `KYSELY` from `DatabaseModule` — is
 * locked. The unit/integration specs construct these classes by hand and so
 * never exercised the DI graph; this does.
 */
describe("saved-tours DI wiring", () => {
  const prev = process.env.DATABASE_URL;

  beforeAll(() => {
    // DatabaseModule's factory reads DATABASE_URL; the KYSELY override below
    // means the factory never actually runs, but keep it set defensively.
    process.env.DATABASE_URL = "postgres://stub";
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  });

  it("resolves SavedToursRepository + SavedToursService with KYSELY from DatabaseModule", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        DatabaseModule,
      ],
      providers: [SavedToursRepository, SavedToursService, CachesRepository],
    })
      // Stub the handle — the repos only store it; no socket is opened.
      .overrideProvider(KYSELY)
      .useValue({})
      .compile();

    expect(moduleRef.get(SavedToursRepository)).toBeInstanceOf(
      SavedToursRepository,
    );
    expect(moduleRef.get(SavedToursService)).toBeInstanceOf(SavedToursService);

    await moduleRef.close();
  });
});
