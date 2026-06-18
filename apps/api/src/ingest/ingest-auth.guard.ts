// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createParamDecorator,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";
import { INGEST_CONFIG, type IngestConfig } from "./ingest.config.js";
import {
  INGEST_TOKEN_RESOLVER,
  type IngestActor,
  type IngestTokenResolver,
} from "./ingest-token-resolver.js";

// Augment Express's Request so request.ingestActor is typed on machine routes.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ingestActor?: IngestActor;
    }
  }
}

const BEARER_PREFIX = "bearer ";

/**
 * Route-level guard for the machine ingestion API (ADR-0033). Reads the
 * `Authorization: Bearer …` token and resolves it to an actor via the
 * {@link IngestTokenResolver} seam. Never reads cookies — this credential is
 * not ambient, so CSRF does not apply. Pairs with `@MachineAuth()`, which makes
 * the global session guard step aside.
 */
@Injectable()
export class IngestAuthGuard implements CanActivate {
  constructor(
    @Inject(INGEST_CONFIG) private readonly cfg: IngestConfig,
    @Inject(INGEST_TOKEN_RESOLVER)
    private readonly resolver: IngestTokenResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Feature off → the route does not function (no token can ever be valid).
    // Treat as not-found-shaped 403 rather than leaking that it exists.
    if (!this.cfg.enabled) {
      throw new ForbiddenException("Machine ingestion API is disabled");
    }

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException("Missing bearer token");
    }
    const token = header.slice(BEARER_PREFIX.length).trim();

    const actor = await this.resolver.resolve(token);
    if (!actor) throw new UnauthorizedException("Invalid ingestion token");

    req.ingestActor = actor;
    return true;
  }
}

/** Resolves the authenticated machine actor populated by IngestAuthGuard. */
export const CurrentIngestActor = createParamDecorator(
  (_data, ctx: ExecutionContext): IngestActor => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const actor = req.ingestActor;
    if (!actor) throw new UnauthorizedException("No machine actor on request");
    return actor;
  },
);
