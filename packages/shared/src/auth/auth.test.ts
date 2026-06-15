// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  LoginInput,
  Password,
  RegisterInput,
  SetPasswordInput,
  isCommonPassword,
} from "./index.js";

describe("password policy (FR-P5)", () => {
  it("rejects passwords shorter than 10 characters", () => {
    expect(Password.safeParse("short1").success).toBe(false);
    expect(Password.safeParse("nine char").success).toBe(false); // 9 chars
  });

  it("accepts a 10-char non-common password", () => {
    expect(Password.safeParse("correct-horse").success).toBe(true);
  });

  it("accepts a long passphrase up to 128 chars but rejects beyond", () => {
    expect(Password.safeParse("a".repeat(128)).success).toBe(true);
    expect(Password.safeParse("a".repeat(129)).success).toBe(false);
  });

  it("rejects common passwords case-insensitively", () => {
    expect(isCommonPassword("password123")).toBe(true);
    expect(isCommonPassword("Password123")).toBe(true);
    expect(isCommonPassword("  PASSWORD123 ")).toBe(true);
    expect(Password.safeParse("password123").success).toBe(false);
    expect(isCommonPassword("an-uncommon-one")).toBe(false);
  });
});

describe("RegisterInput / LoginInput", () => {
  it("trims and bounds displayName, validates email", () => {
    const ok = RegisterInput.safeParse({
      email: "user@example.com",
      password: "correct-horse-battery",
      displayName: "  Jane  ",
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.displayName).toBe("Jane");

    expect(
      RegisterInput.safeParse({
        email: "not-an-email",
        password: "correct-horse-battery",
        displayName: "Jane",
      }).success,
    ).toBe(false);
  });

  it("login accepts any non-empty password (policy not re-applied)", () => {
    expect(
      LoginInput.safeParse({ email: "u@e.com", password: "x" }).success,
    ).toBe(true);
    expect(
      LoginInput.safeParse({ email: "u@e.com", password: "" }).success,
    ).toBe(false);
  });
});

describe("SetPasswordInput (FR-P5a)", () => {
  it("requires a policy-compliant newPassword; currentPassword is optional", () => {
    expect(
      SetPasswordInput.safeParse({ newPassword: "correct-horse-battery" })
        .success,
    ).toBe(true);
    expect(
      SetPasswordInput.safeParse({
        currentPassword: "x",
        newPassword: "correct-horse-battery",
      }).success,
    ).toBe(true);
    // newPassword still under the full FR-P5 policy
    expect(SetPasswordInput.safeParse({ newPassword: "short" }).success).toBe(
      false,
    );
    expect(
      SetPasswordInput.safeParse({ newPassword: "password123" }).success,
    ).toBe(false);
  });
});
