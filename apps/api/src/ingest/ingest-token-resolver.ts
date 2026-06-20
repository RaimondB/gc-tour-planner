// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { INGEST_CONFIG, type IngestConfig } from "./ingest.config.js";

/** The identity a valid machine token resolves to. */
export interface IngestActor {
  ownerId: string;
}

/**
 * Resolves a presented bearer token to an actor, or null when the token is not
 * valid. This is the seam (ADR-0033): the shipped implementation compares
 * against a single env key and attributes to one owner, but a future
 * DB-backed per-user PAT store can replace the provider behind this interface
 * with zero change to the guard, controller, or the adapter contract.
 */
export interface IngestTokenResolver {
  resolve(token: string): Promise<IngestActor | null>;
}

/** DI token for the active {@link IngestTokenResolver}. */
export const INGEST_TOKEN_RESOLVER = Symbol.for(
  "@gctp/api/ingest/INGEST_TOKEN_RESOLVER",
);

/** Constant-time string compare that never short-circuits on length. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal-length buffers; compare against a fixed-size
  // digest-like padding would be overkill here — instead guard the length and
  // still run the compare on a same-length copy so timing does not leak it.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Env-keyed resolver: a single shared `INGEST_API_KEY` maps to a single
 * `INGEST_OWNER_ID`. Returns null for any non-matching token and whenever the
 * feature is disabled (the config carries null key/owner).
 */
@Injectable()
export class EnvIngestTokenResolver implements IngestTokenResolver {
  constructor(@Inject(INGEST_CONFIG) private readonly cfg: IngestConfig) {}

  async resolve(token: string): Promise<IngestActor | null> {
    if (!this.cfg.enabled || !this.cfg.apiKey || !this.cfg.ownerId) return null;
    if (!token) return null;
    if (!constantTimeEquals(token, this.cfg.apiKey)) return null;
    return { ownerId: this.cfg.ownerId };
  }
}
