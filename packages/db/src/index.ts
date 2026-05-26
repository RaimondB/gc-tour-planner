// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

export type {
  Database,
  PrecomputeKind,
  PrecomputeState,
} from "./schema.js";

export interface CreateDbOptions {
  /** PostgreSQL connection string, e.g. `postgresql://user:pass@host:5432/db`. */
  url: string;
  /** Connection pool max. Default 10. */
  poolMax?: number;
}

export function createDb({
  url,
  poolMax = 10,
}: CreateDbOptions): Kysely<Database> {
  const pool = new pg.Pool({ connectionString: url, max: poolMax });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}
