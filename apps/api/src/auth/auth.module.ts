// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { DatabaseModule } from "../database/database.module.js";
import { authConfigProvider, AUTH_CONFIG } from "./auth.config.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { DevUserService } from "./dev-user.service.js";
import { GoogleOAuthService } from "./google-oauth.service.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { LoginLimiterService } from "./login-limiter.service.js";
import { PasswordService } from "./password.service.js";
import { SessionService } from "./session.service.js";
import { TurnstileService } from "./turnstile.service.js";
import { UsersRepository } from "./users.repository.js";

import "./auth.types.js"; // side-effect: augments Express.Request.

/**
 * Real authentication (M6-α, ADR-0021). Replaces the dev-user middleware with a
 * global {@link JwtAuthGuard} (registered via APP_GUARD) backed by Valkey
 * sessions. Everything is authenticated by default; only `@Public()` routes are
 * exempt. The `@CurrentUser()` / `AuthUser` contract is unchanged — every
 * owner-scoped repository keeps working without signature changes.
 *
 * The Valkey client (ValkeyModule) and the throttler (ThrottlerModule) are
 * wired globally in AppModule.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [
    authConfigProvider,
    PasswordService,
    SessionService,
    LoginLimiterService,
    UsersRepository,
    DevUserService,
    GoogleOAuthService,
    TurnstileService,
    AuthService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AUTH_CONFIG, SessionService],
})
export class AuthModule {}
