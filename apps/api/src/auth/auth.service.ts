// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Auth } from "@gctp/shared";
import type { AuthUser } from "./auth.types.js";
import type { GoogleProfile } from "./google-oauth.service.js";
import { LoginLimiterService } from "./login-limiter.service.js";
import { PasswordService } from "./password.service.js";
import { SessionService } from "./session.service.js";
import { UsersRepository, type UserRow } from "./users.repository.js";

/** A freshly established session, returned to the controller to set cookies. */
export interface EstablishedSession {
  user: AuthUser;
  sessionId: string;
  csrf: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly limiter: LoginLimiterService,
  ) {}

  private toAuthUser(row: UserRow): AuthUser {
    return { id: row.id, email: row.email, displayName: row.displayName };
  }

  private async establish(user: AuthUser): Promise<EstablishedSession> {
    const { sessionId, csrf } = await this.sessions.create(user);
    return { user, sessionId, csrf };
  }

  /** Self-service registration (FR-P5). Duplicate email → 409. */
  async register(input: Auth.RegisterInput): Promise<EstablishedSession> {
    await this.limiter.hit("register", input.email);
    const passwordHash = await this.passwords.hash(input.password);
    const row = await this.users.create({
      email: input.email,
      displayName: input.displayName,
      passwordHash,
    });
    if (!row) {
      throw new ConflictException("Email already registered");
    }
    return this.establish(this.toAuthUser(row));
  }

  /**
   * Password login. Generic "Invalid credentials" on every failure path, and a
   * dummy hash on the user-missing path so response timing doesn't reveal
   * whether the email exists (FR-P9 — no enumeration).
   */
  async login(input: Auth.LoginInput): Promise<EstablishedSession> {
    await this.limiter.hit("login", input.email);
    const row = await this.users.findByEmail(input.email);

    if (!row || !row.passwordHash) {
      // Equalise timing with the verify path even when there's nothing to verify.
      await this.passwords.hash(input.password);
      throw new UnauthorizedException("Invalid credentials");
    }

    const ok = await this.passwords.verify(row.passwordHash, input.password);
    if (!ok) throw new UnauthorizedException("Invalid credentials");

    await this.limiter.reset("login", input.email);
    return this.establish(this.toAuthUser(row));
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.sessions.destroy(sessionId);
  }

  /**
   * Establish a session from a verified Google profile (ADR-0021 §5). Links to
   * an existing account by **verified** email, else creates an OAuth-only user
   * (`password_hash IS NULL`). An unverified Google email is refused — it must
   * never silently link to or create an account.
   */
  async oauthLogin(profile: GoogleProfile): Promise<EstablishedSession> {
    if (!profile.emailVerified) {
      throw new UnauthorizedException("Google email is not verified");
    }

    const existing = await this.users.findByEmail(profile.email);
    if (existing) return this.establish(this.toAuthUser(existing));

    const displayName =
      profile.name?.trim() || profile.email.split("@")[0] || profile.email;
    const created = await this.users.create({
      email: profile.email,
      displayName,
      passwordHash: null,
    });
    // On a create race (concurrent first sign-in), fall back to the now-present row.
    const row = created ?? (await this.users.findByEmail(profile.email));
    if (!row) throw new UnauthorizedException("Could not establish account");
    return this.establish(this.toAuthUser(row));
  }
}
