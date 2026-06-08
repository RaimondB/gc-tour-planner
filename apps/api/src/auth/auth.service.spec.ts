// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service.js";
import type { GoogleProfile } from "./google-oauth.service.js";
import type { LoginLimiterService } from "./login-limiter.service.js";
import type { PasswordService } from "./password.service.js";
import type { SessionService } from "./session.service.js";
import type { UserRow, UsersRepository } from "./users.repository.js";

const USER: UserRow = {
  id: "u1",
  email: "jane@example.com",
  displayName: "Jane",
  passwordHash: "$argon2id$stored",
  isAdmin: false,
};

describe("AuthService", () => {
  let users: Record<keyof UsersRepository, ReturnType<typeof vi.fn>>;
  let passwords: Record<keyof PasswordService, ReturnType<typeof vi.fn>>;
  let sessions: { create: ReturnType<typeof vi.fn> };
  let limiter: Record<keyof LoginLimiterService, ReturnType<typeof vi.fn>>;
  let service: AuthService;

  beforeEach(() => {
    users = {
      findByEmail: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
    } as never;
    passwords = { hash: vi.fn(), verify: vi.fn() } as never;
    sessions = {
      create: vi.fn().mockResolvedValue({ sessionId: "sid", csrf: "csrf" }),
    };
    limiter = { hit: vi.fn(), reset: vi.fn() } as never;
    service = new AuthService(
      users as unknown as UsersRepository,
      passwords as unknown as PasswordService,
      sessions as unknown as SessionService,
      limiter as unknown as LoginLimiterService,
    );
  });

  describe("register", () => {
    it("hashes, creates, and establishes a session", async () => {
      passwords.hash.mockResolvedValue("$argon2id$new");
      users.create.mockResolvedValue(USER);
      const result = await service.register({
        email: "jane@example.com",
        password: "correct-horse-battery",
        displayName: "Jane",
      });
      expect(passwords.hash).toHaveBeenCalledWith("correct-horse-battery");
      expect(result.user).toEqual({
        id: "u1",
        email: "jane@example.com",
        displayName: "Jane",
        isAdmin: false,
      });
      expect(result.sessionId).toBe("sid");
    });

    it("throws 409 on a duplicate email", async () => {
      passwords.hash.mockResolvedValue("$argon2id$new");
      users.create.mockResolvedValue(null); // unique violation
      await expect(
        service.register({
          email: "jane@example.com",
          password: "correct-horse-battery",
          displayName: "Jane",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("login", () => {
    it("verifies the password and resets the per-email limiter", async () => {
      users.findByEmail.mockResolvedValue(USER);
      passwords.verify.mockResolvedValue(true);
      const result = await service.login({
        email: "jane@example.com",
        password: "pw",
      });
      expect(result.user.id).toBe("u1");
      expect(limiter.reset).toHaveBeenCalledWith("login", "jane@example.com");
    });

    it("returns a generic 401 and burns a hash when the user is missing (anti-enumeration)", async () => {
      users.findByEmail.mockResolvedValue(undefined);
      await expect(
        service.login({ email: "ghost@example.com", password: "pw" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(passwords.hash).toHaveBeenCalled(); // timing equalisation
      expect(passwords.verify).not.toHaveBeenCalled();
    });

    it("401s on a wrong password", async () => {
      users.findByEmail.mockResolvedValue(USER);
      passwords.verify.mockResolvedValue(false);
      await expect(
        service.login({ email: "jane@example.com", password: "nope" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("401s for an OAuth-only user (no password hash)", async () => {
      users.findByEmail.mockResolvedValue({ ...USER, passwordHash: null });
      await expect(
        service.login({ email: "jane@example.com", password: "pw" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(passwords.hash).toHaveBeenCalled();
    });
  });

  describe("oauthLogin", () => {
    const verified: GoogleProfile = {
      sub: "g-sub",
      email: "jane@example.com",
      emailVerified: true,
      name: "Jane G",
    };

    it("links to an existing account by verified email", async () => {
      users.findByEmail.mockResolvedValue(USER);
      const result = await service.oauthLogin(verified);
      expect(result.user.id).toBe("u1");
      expect(users.create).not.toHaveBeenCalled();
    });

    it("creates an OAuth-only user when none exists", async () => {
      users.findByEmail.mockResolvedValue(undefined);
      users.create.mockResolvedValue({ ...USER, passwordHash: null });
      const result = await service.oauthLogin(verified);
      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "jane@example.com",
          passwordHash: null,
        }),
      );
      expect(result.user.id).toBe("u1");
    });

    it("refuses an unverified Google email", async () => {
      await expect(
        service.oauthLogin({ ...verified, emailVerified: false }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(users.findByEmail).not.toHaveBeenCalled();
    });
  });
});
