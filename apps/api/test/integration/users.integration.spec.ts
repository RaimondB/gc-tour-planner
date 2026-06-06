// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsersRepository } from "../../src/auth/users.repository.js";
import {
  type PostgresFixture,
  startPostgres,
  stopPostgres,
} from "./postgres-fixture.js";

describe("UsersRepository (PostGIS via Testcontainers)", () => {
  let pg: PostgresFixture;
  let repo: UsersRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    repo = new UsersRepository(pg.db);
  });

  afterAll(async () => {
    await stopPostgres(pg);
  });

  it("creates a password user and reads it back", async () => {
    const created = await repo.create({
      email: "jane@example.com",
      displayName: "Jane",
      passwordHash: "$argon2id$fakehash",
    });
    expect(created).not.toBeNull();
    expect(created?.email).toBe("jane@example.com");
    expect(created?.passwordHash).toBe("$argon2id$fakehash");

    const byId = await repo.findById(created!.id);
    expect(byId?.displayName).toBe("Jane");
  });

  it("looks up by email case-insensitively (CITEXT)", async () => {
    const found = await repo.findByEmail("JANE@EXAMPLE.COM");
    expect(found?.email).toBe("jane@example.com");
  });

  it("returns null on a duplicate email (case-insensitive unique)", async () => {
    const dup = await repo.create({
      email: "Jane@Example.com",
      displayName: "Imposter",
      passwordHash: "$argon2id$other",
    });
    expect(dup).toBeNull();
  });

  it("creates an OAuth-only user with a null password hash", async () => {
    const oauth = await repo.create({
      email: "oauth@example.com",
      displayName: "OAuth User",
      passwordHash: null,
    });
    expect(oauth?.passwordHash).toBeNull();
  });

  it("returns undefined for an unknown email", async () => {
    expect(await repo.findByEmail("nobody@example.com")).toBeUndefined();
  });
});
