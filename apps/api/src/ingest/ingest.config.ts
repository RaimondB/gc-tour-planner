// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** DI token for the resolved, validated machine-ingestion configuration. */
export const INGEST_CONFIG = Symbol.for("@gctp/api/ingest/INGEST_CONFIG");

export interface IngestConfig {
  /**
   * Master switch for the machine ingestion API (FR-I14). Default OFF — a
   * deploy that does not set INGEST_API_ENABLED exposes no machine route.
   */
  enabled: boolean;
  /**
   * Shared bearer token presented by external source adapters in the
   * `Authorization: Bearer …` header. Env-only — never stored in the DB
   * (mirrors the M8 partner-key pattern). null when the feature is disabled.
   */
  apiKey: string | null;
  /**
   * The single owner all machine-ingested caches are attributed to. This is
   * the env-keyed actor identity; the resolver seam (IngestTokenResolver) lets
   * a future DB-backed per-user token store supersede it without a contract
   * change for adapters. null when the feature is disabled.
   */
  ownerId: string | null;
}

function bool(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

/**
 * Resolve ingestion config from the environment, failing fast at boot on a
 * misconfigured deploy rather than on the first push. When disabled the
 * factory short-circuits so a feature that is off never blocks startup.
 */
export function loadIngestConfig(config: ConfigService): IngestConfig {
  const enabled = bool(config.get<string>("INGEST_API_ENABLED"));
  if (!enabled) {
    return { enabled: false, apiKey: null, ownerId: null };
  }

  const apiKey = config.get<string>("INGEST_API_KEY")?.trim() ?? "";
  const ownerId = config.get<string>("INGEST_OWNER_ID")?.trim() ?? "";
  if (!apiKey || !ownerId) {
    throw new Error(
      "INGEST_API_ENABLED=1 requires both INGEST_API_KEY and INGEST_OWNER_ID " +
        "(see infra/.env.example). Refusing to boot with the machine ingestion " +
        "API enabled but unconfigured.",
    );
  }

  return { enabled: true, apiKey, ownerId };
}

export const ingestConfigProvider: Provider = {
  provide: INGEST_CONFIG,
  useFactory: loadIngestConfig,
  inject: [ConfigService],
};
