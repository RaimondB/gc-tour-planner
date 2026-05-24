// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { DevUserMiddleware } from "./dev-user.middleware.js";

import "./auth.types.js"; // side-effect: augments Express.Request.

/**
 * Until M6, this module wires the dev-user middleware globally. The real
 * authentication module (JWT cookie + Passport) replaces it without changing
 * the CurrentUser decorator contract.
 */
@Module({
  imports: [DatabaseModule],
  providers: [DevUserMiddleware],
  exports: [DevUserMiddleware],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "DevUserMiddleware must not run in production. Replace AuthModule with the JWT auth module in M6.",
      );
    }
    consumer.apply(DevUserMiddleware).forRoutes("*");
  }
}
