// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { PasswordService } from "./password.service.js";

describe("PasswordService (argon2id)", () => {
  const service = new PasswordService();

  it("produces an argon2id encoded hash that verifies", async () => {
    const hash = await service.hash("correct-horse-battery");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await service.verify(hash, "correct-horse-battery")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await service.hash("correct-horse-battery");
    expect(await service.verify(hash, "wrong-password-xyz")).toBe(false);
  });

  it("returns false (never throws) on a malformed hash", async () => {
    expect(await service.verify("not-a-real-hash", "anything")).toBe(false);
  });

  it("salts: two hashes of the same password differ", async () => {
    const a = await service.hash("same-password-here");
    const b = await service.hash("same-password-here");
    expect(a).not.toBe(b);
  });
});
