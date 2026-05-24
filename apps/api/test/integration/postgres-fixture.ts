// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Boots a PostGIS container via Testcontainers, applies migrations, and exposes
// a Kysely instance. Per CLAUDE.md and ADR rationale: integration tests hit a
// real database — never a mock.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDb, type Database } from "@gctp/db";
import type { Kysely } from "kysely";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

export interface PostgresFixture {
  container: StartedPostgreSqlContainer;
  url: string;
  db: Kysely<Database>;
}

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

export async function startPostgres(): Promise<PostgresFixture> {
  const container = await new PostgreSqlContainer("postgis/postgis:16-3.4")
    .withDatabase("gctp_test")
    .withUsername("gctp")
    .withPassword("gctp")
    .withStartupTimeout(120_000)
    .start();

  const url = container.getConnectionUri();

  // Apply migrations via pnpm so we don't hard-code the .pnpm-store binary path.
  execFileSync("pnpm", ["--filter", "@gctp/db", "migrate:up"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });

  return { container, url, db: createDb({ url }) };
}

export async function stopPostgres(
  fix: PostgresFixture | undefined,
): Promise<void> {
  if (!fix) return;
  await fix.db.destroy().catch(() => undefined);
  await fix.container.stop().catch(() => undefined);
}
