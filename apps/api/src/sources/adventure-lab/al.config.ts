// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** DI token for the resolved Adventure Lab enrichment configuration. */
export const ADVENTURE_LAB_CONFIG = Symbol.for(
  "@gctp/api/sources/adventure-lab/CONFIG",
);

export interface AdventureLabConfig {
  /**
   * Admin master switch for server-side Adventure Lab cluster enrichment.
   * Default OFF — a deploy that doesn't set ADVENTURE_LAB_ENRICHMENT_ENABLED
   * never calls out to Lab2Gpx, regardless of a request's `includeAdventureLabs`.
   * Lets the operator dogfood enrichment in production before exposing it.
   */
  enabled: boolean;
  /**
   * Base URL of the Lab2Gpx service (`POST <base>/download` returns GPX for an
   * area). Overridable so a test/staging deploy can point elsewhere; defaults
   * to the public instance. Unauthenticated — no key (Lab2Gpx holds its own).
   */
  apiBaseUrl: string;
}

function bool(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

/**
 * Resolve enrichment config from the environment. Unlike the ingestion config
 * there are no required companions when enabled — Lab2Gpx is unauthenticated —
 * so this never throws at boot.
 */
export function loadAdventureLabConfig(
  config: ConfigService,
): AdventureLabConfig {
  const enabled = bool(config.get<string>("ADVENTURE_LAB_ENRICHMENT_ENABLED"));
  const apiBaseUrl =
    config.get<string>("ADVENTURE_LAB_API_URL")?.trim() ||
    "https://api.lab2gpx.gcutils.de";
  return { enabled, apiBaseUrl };
}

export const adventureLabConfigProvider: Provider = {
  provide: ADVENTURE_LAB_CONFIG,
  useFactory: loadAdventureLabConfig,
  inject: [ConfigService],
};
