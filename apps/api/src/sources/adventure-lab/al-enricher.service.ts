// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable, Logger } from "@nestjs/common";
import { GpxService } from "../../gpx/gpx.service.js";
import { ADVENTURE_LAB_CONFIG, type AdventureLabConfig } from "./al.config.js";

/** The planning area to enrich: a center point and a radius in metres. */
export interface EnrichArea {
  center: readonly [number, number]; // [lng, lat]
  radiusM: number;
}

export interface EnrichResult {
  /** Stages upserted into the caller's caches (new + updated). */
  importedCaches: number;
}

/**
 * Fetch the area beyond the planning radius so an Adventure whose stages
 * straddle the edge isn't clipped (the planner discards out-of-radius caches
 * anyway, so over-fetching is harmless).
 */
const ENRICH_BUFFER_KM = 1;
/** Upper bound on stages fetched per area (Lab2Gpx `take`). */
const ENRICH_LIMIT = 500;
/** Abort the Lab2Gpx call after this so a slow upstream can't stall a plan. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Server-side Adventure Lab cluster enrichment.
 *
 * Before clustering, fetch the planning area's Adventure Lab stages from
 * Lab2Gpx (which holds the Groundspeak consumer key — we never touch the AL API
 * directly) and import them through the ordinary GPX ingest path. Reusing
 * `GpxService.ingest` is deliberate:
 *   - the stages dedupe against any the user imported manually (same
 *     `source='gpx'`, same Lab2Gpx codes) — no double rows;
 *   - `parseGpx` already extracts the adventure deep-link (FR — Phase 1), so the
 *     "Open in Adventure Lab" popup link works on enriched stages too;
 *   - the ingest path enqueues the walking-precompute re-warm, so the new
 *     stages get OSRM legs for routing.
 *
 * Best-effort: any failure (flag off, upstream down, parse error) logs and
 * returns null — a planning request never fails because enrichment didn't run.
 */
@Injectable()
export class AdventureLabEnricher {
  private readonly logger = new Logger(AdventureLabEnricher.name);

  constructor(
    @Inject(ADVENTURE_LAB_CONFIG)
    private readonly config: AdventureLabConfig,
    private readonly gpx: GpxService,
  ) {}

  /** Whether the admin flag is on (the request flag alone isn't enough). */
  get enabled(): boolean {
    return this.config.enabled;
  }

  async enrich(
    ownerId: string,
    area: EnrichArea,
  ): Promise<EnrichResult | null> {
    if (!this.config.enabled) return null;
    try {
      const gpx = await this.fetchAreaGpx(area);
      if (!gpx) return null;
      const result = await this.gpx.ingest(
        ownerId,
        "adventure-lab-enrichment.gpx",
        gpx,
        {},
      );
      this.logger.log(
        `Adventure Lab enrichment for owner=${ownerId}: ` +
          `${result.cachesUpserted} stage(s) upserted` +
          (result.duplicate ? " (unchanged — dedup skip)" : ""),
      );
      return { importedCaches: result.cachesUpserted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Adventure Lab enrichment failed for owner=${ownerId}: ${message}. ` +
          `Planning continues without lab stages.`,
      );
      return null;
    }
  }

  /**
   * POST the area to Lab2Gpx and return the GPX body, or null on a non-OK
   * response / empty body. The request shape matches the documented Lab2Gpx
   * `/download` API (https://github.com/mirsch/lab2gpx/wiki/Api).
   */
  private async fetchAreaGpx(area: EnrichArea): Promise<string | null> {
    const [lng, lat] = area.center;
    const radiusKm = Math.ceil(area.radiusM / 1000) + ENRICH_BUFFER_KM;
    const body = {
      version: 2,
      locale: "en",
      radius: radiusKm,
      coordinates: { lat, lon: lng },
      limit: ENRICH_LIMIT,
      cacheType: "Lab Cache",
      // "default" keeps every stage's posted coordinate; we don't need the
      // [L]-prefix marking (sequential ordering is a later phase).
      linear: "default",
      prefix: "LC",
      stageSeparator: false,
      customCodeTemplate: null,
      userGuid: null,
      completionStatuses: ["0", "1", "2"],
      includeQuestion: false,
      includeWaypointDescription: false,
      includeCacheDescription: false,
      excludeOwner: null,
      excludeNames: null,
      excludeUuids: null,
      quirksL4Ctype: false,
      outputFormat: "gpx",
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.config.apiBaseUrl}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(
          `Lab2Gpx /download returned ${res.status} for ` +
            `(${lat},${lng}) r=${radiusKm}km`,
        );
        return null;
      }
      const text = await res.text();
      return text.trim().length > 0 ? text : null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
