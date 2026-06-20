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

/** Extra km fetched beyond the requested radius so edge adventures aren't clipped. */
const DEFAULT_BUFFER_KM = 1;
/**
 * Default cap on **adventures** (Lab2Gpx `limit` counts adventures, not stages —
 * each yields ~5-10 stages). Small by design: the cluster-augment path passes a
 * tiny value; the bulk background import passes a large one.
 */
const DEFAULT_LIMIT_ADVENTURES = 50;
/** Abort the Lab2Gpx call after this so a slow upstream can't stall the caller. */
const FETCH_TIMEOUT_MS = 30_000;

export interface EnrichOptions {
  /** Max adventures to fetch (Lab2Gpx `limit`). Small for augment, large for bulk. */
  limitAdventures?: number;
  /** Extra km beyond `radiusM`. Defaults to 1 km. */
  bufferKm?: number;
}

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
    opts: EnrichOptions = {},
  ): Promise<EnrichResult | null> {
    if (!this.config.enabled) return null;
    try {
      const gpx = await this.fetchAreaGpx(area, opts);
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
   * `/download` API (https://github.com/mirsch/lab2gpx/wiki/Api). Public so the
   * adventure_id backfill (FR-I17) can re-fetch an adventure's area and read the
   * fresh `goto/<guid>` deep-links without going through the full ingest path.
   */
  async fetchAreaGpx(
    area: EnrichArea,
    opts: EnrichOptions,
  ): Promise<string | null> {
    const [lng, lat] = area.center;
    const radiusKm =
      Math.ceil(area.radiusM / 1000) + (opts.bufferKm ?? DEFAULT_BUFFER_KM);
    const body = {
      version: 2,
      locale: "en",
      radius: radiusKm,
      coordinates: { lat, lon: lng },
      limit: opts.limitAdventures ?? DEFAULT_LIMIT_ADVENTURES,
      cacheType: "Lab Cache",
      // "mark" keeps every stage's posted coordinate AND prefixes a *linear*
      // adventure's stage names with "[L] " (the GC IsLinear flag), which the
      // parser reads into `adventureSequential` to drive in-order routing.
      // (Unlike "first", mark never drops stages; unlike "corrected", it leaves
      // coordinates untouched.)
      linear: "mark",
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
