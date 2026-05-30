// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Inject, Injectable, Logger } from "@nestjs/common";

/**
 * DI token for the directory raw GPX uploads live in. Bound from
 * `UPLOADS_DIR` env at module construction. Tests override with a
 * tmp dir.
 */
export const UPLOADS_DIR = Symbol("UPLOADS_DIR");

/**
 * On-disk store for raw uploaded GPX bytes, gzipped at
 * `{UPLOADS_DIR}/{uploadId}.gpx.gz`. Keeping the originals lets the
 * admin "reprocess" path re-parse old uploads when we add new fields
 * (first use: the upcoming `disabled`/`archived` filter) without
 * making the user re-upload.
 *
 * Why filesystem + docker volume rather than `BYTEA` in Postgres:
 *   * Postgres dump size stays small — PQs run 0.5-5 MB each, lifetime
 *     storage across years multiplied by every active user is the kind
 *     of growth that makes daily DB backups painful.
 *   * Reprocess is a streaming open + gunzip; no large `bytea` reads
 *     through node-pg.
 *   * Backup story: tar the named volume alongside the DB dump. One
 *     extra step; not invisible.
 *
 * Why gzip:
 *   * GPX is XML, compresses 5-10x. A 30 MB PQ becomes ~3-4 MB on disk.
 *   * Node's `zlib.gzipSync` is sync but fast enough at our sizes
 *     (single-user, low concurrency); not worth the streaming
 *     complexity. Revisit when we have multiple concurrent users.
 *
 * Naming: `{uploadId}.gpx.gz` is deterministic from the DB row — no
 * separate `raw_path` column needed. The `raw_size_bytes` column
 * doubles as "is the raw stored at all?" via NULL-check.
 */
@Injectable()
export class GpxStorageService {
  private readonly logger = new Logger(GpxStorageService.name);
  private dirEnsured = false;

  constructor(@Inject(UPLOADS_DIR) private readonly dir: string) {
    if (!dir || typeof dir !== "string") {
      throw new Error(
        "GpxStorageService requires a non-empty UPLOADS_DIR. " +
          "Set the UPLOADS_DIR env var (e.g. UPLOADS_DIR=/srv/uploads).",
      );
    }
  }

  /**
   * Gzip the XML, write to disk, return size + SHA-256 of the
   * *uncompressed* bytes (so the DB checksum stays stable across
   * future re-compressions with different zlib settings).
   */
  async save(
    uploadId: string,
    xml: string,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    await this.ensureDir();
    const path = this.pathFor(uploadId);
    const xmlBuf = Buffer.from(xml, "utf8");
    const sha256 = createHash("sha256").update(xmlBuf).digest("hex");
    const gz = gzipSync(xmlBuf, { level: 9 });
    await writeFile(path, gz);
    return { sizeBytes: gz.byteLength, sha256 };
  }

  /**
   * Read + gunzip. Throws when the file is missing — callers handle
   * the "raw not stored" case by checking `gpx_uploads.raw_size_bytes`
   * before calling.
   */
  async read(uploadId: string): Promise<string> {
    const path = this.pathFor(uploadId);
    const gz = await readFile(path);
    return gunzipSync(gz).toString("utf8");
  }

  /**
   * Best-effort delete — used by the reprocess path's caller when a
   * row's raw is being intentionally discarded. Missing files don't
   * throw (logs a debug line instead) so retry-on-failure paths stay
   * idempotent.
   */
  async delete(uploadId: string): Promise<void> {
    const path = this.pathFor(uploadId);
    try {
      await unlink(path);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        this.logger.debug(`delete(${uploadId}): no file, skipping`);
        return;
      }
      throw err;
    }
  }

  private pathFor(uploadId: string): string {
    // Defensive — uploadId comes from the DB so it's already a UUID,
    // but `..` / `/` in a stray test fixture would escape the dir.
    if (uploadId.includes("/") || uploadId.includes("..")) {
      throw new Error(`Invalid uploadId for storage path: ${uploadId}`);
    }
    return join(this.dir, `${uploadId}.gpx.gz`);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(this.dir, { recursive: true });
    this.dirEnsured = true;
  }
}
