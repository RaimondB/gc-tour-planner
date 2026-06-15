// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { Auth } from "@gctp/shared";
import type { Request, Response } from "express";
import type { AuthUser } from "./auth.types.js";
import type { AuthConfig } from "./auth.config.js";
import { AUTH_CONFIG } from "./auth.config.js";
import { AuthService, type EstablishedSession } from "./auth.service.js";
import { clientIp, trustCfFromEnv, type IpRequest } from "./client-ip.js";
import {
  clearAuthCookies,
  setCsrfCookie,
  setSessionCookie,
  SESSION_COOKIE,
} from "./cookies.js";
import { CurrentUser } from "./current-user.decorator.js";
import { GoogleOAuthService } from "./google-oauth.service.js";
import { Public } from "./public.decorator.js";
import { TurnstileService } from "./turnstile.service.js";

/** Per-IP throttle for the credential endpoints (FR-P9). */
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } } as const;

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleOAuthService,
    private readonly turnstile: TurnstileService,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
  ) {}

  /** Set both auth cookies from a freshly established session. */
  private applySession(
    res: Response,
    established: EstablishedSession,
  ): AuthUser {
    setSessionCookie(res, this.cfg, established.sessionId);
    setCsrfCookie(res, this.cfg, established.csrf);
    return established.user;
  }

  @Post("register")
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({ summary: "Self-service registration (email + password)" })
  @ApiResponse({ status: 201, description: "Registered; session established." })
  @ApiResponse({
    status: 400,
    description: "Invalid input or missing captcha.",
  })
  @ApiResponse({ status: 403, description: "Captcha verification failed." })
  @ApiResponse({ status: 409, description: "Email already registered." })
  async register(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUser> {
    const parsed = Auth.RegisterInput.safeParse(req.body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    // Human-verification gate (FR-P5, Gate 1.4). The token rides alongside the
    // account fields in the body; RegisterInput strips it. No-op when disabled.
    const body = req.body as { turnstileToken?: unknown };
    const token =
      typeof body?.turnstileToken === "string"
        ? body.turnstileToken
        : undefined;
    await this.turnstile.verify(
      token,
      clientIp(req as unknown as IpRequest, {
        trustCfConnectingIp: trustCfFromEnv(),
      }),
    );
    const established = await this.auth.register(parsed.data);
    return this.applySession(res, established);
  }

  @Post("login")
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle(AUTH_THROTTLE)
  @HttpCode(200)
  @ApiOperation({ summary: "Password login; establishes a session" })
  @ApiResponse({ status: 200, description: "Logged in; session established." })
  @ApiResponse({ status: 401, description: "Invalid credentials." })
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUser> {
    const parsed = Auth.LoginInput.safeParse(req.body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const established = await this.auth.login(parsed.data);
    return this.applySession(res, established);
  }

  @Post("logout")
  @HttpCode(204)
  @ApiOperation({ summary: "Logout; clears cookies and deletes the session" })
  @ApiResponse({ status: 204, description: "Logged out." })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const sessionId = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ];
    await this.auth.logout(sessionId);
    clearAuthCookies(res, this.cfg);
  }

  @Post("password")
  @HttpCode(204)
  @ApiOperation({
    summary: "Set or change the signed-in user's password",
  })
  @ApiResponse({ status: 204, description: "Password updated." })
  @ApiResponse({
    status: 400,
    description: "Invalid input, or current password required but missing.",
  })
  @ApiResponse({
    status: 401,
    description: "Not authenticated, or current password incorrect.",
  })
  async setPassword(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ): Promise<void> {
    const parsed = Auth.SetPasswordInput.safeParse(req.body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.auth.setPassword(user.id, parsed.data);
  }

  @Get("me")
  @ApiOperation({ summary: "The currently authenticated user" })
  @ApiResponse({ status: 200, description: "The current AuthUser." })
  @ApiResponse({ status: 401, description: "Not authenticated." })
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @Get("google")
  @Public()
  @ApiOperation({ summary: "Begin Google OAuth (redirects to Google)" })
  @ApiResponse({
    status: 302,
    description: "Redirect to the Google consent screen.",
  })
  async googleStart(@Res() res: Response): Promise<void> {
    const url = await this.google.authorizationUrl();
    res.redirect(url);
  }

  @Get("google/callback")
  @Public()
  @ApiOperation({ summary: "Google OAuth return; establishes a session" })
  @ApiResponse({
    status: 302,
    description: "Redirect to the app after sign-in.",
  })
  async googleCallback(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const query = req.query as Record<string, string | undefined>;
    await this.google.verifyState(query.state);
    const profile = await this.google.exchangeCode(query.code);
    const established = await this.auth.oauthLogin(profile);
    this.applySession(res, established);
    res.redirect(this.cfg.postLoginRedirect);
  }
}
