// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

/**
 * Tracks the identifier of the live OSRM extract so cached `route_legs` rows
 * can be tagged with it (and rows from a previous extract are filtered out
 * on read). The bootstrap script writes the hash to
 * `${OSRM_VERSION_FILE}` (default `/osrm-meta/osrm-version.txt`); we re-read
 * it on each call so an extract refresh is picked up without restarting the
 * API. The re-read is one stat + read of a 16-byte file — well under a ms.
 *
 * Falls back to the sentinel `'unknown'` when the file is missing. That keeps
 * the API working on dev boxes that haven't mounted the `osrm-data` volume,
 * at the cost of a single cache namespace shared with the migration's
 * default. Tagging existing rows with `'unknown'` means a real extract going
 * live will naturally invalidate them.
 */
export const UNKNOWN_OSRM_VERSION = "unknown";

@Injectable()
export class OsrmVersionService implements OnModuleInit {
  private readonly logger = new Logger(OsrmVersionService.name);
  private cached: string = UNKNOWN_OSRM_VERSION;
  private readonly path: string;

  constructor() {
    this.path = process.env.OSRM_VERSION_FILE ?? "/osrm-meta/osrm-version.txt";
  }

  onModuleInit(): void {
    this.cached = this.readFromDisk();
    this.logger.log(`OSRM extract version: ${this.cached} (from ${this.path})`);
  }

  /**
   * Returns the current OSRM extract version. Re-reads the file each call so
   * an in-place extract rebuild is reflected without a service restart. Reads
   * are bounded (16 bytes) and the OS page cache absorbs the cost.
   */
  getVersion(): string {
    const latest = this.readFromDisk();
    if (latest !== this.cached) {
      this.logger.log(
        `OSRM extract version changed: ${this.cached} -> ${latest}`,
      );
      this.cached = latest;
    }
    return this.cached;
  }

  private readFromDisk(): string {
    try {
      const raw = readFileSync(this.path, "utf8").trim();
      return raw.length > 0 ? raw : UNKNOWN_OSRM_VERSION;
    } catch {
      return UNKNOWN_OSRM_VERSION;
    }
  }
}
