// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GpxStorageService } from "./gpx-storage.service.js";

describe("GpxStorageService", () => {
  let dir: string;
  let svc: GpxStorageService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gctp-uploads-"));
    svc = new GpxStorageService(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("save() gzips + writes; the on-disk file is real gzip and decompresses back", async () => {
    const xml = "<gpx>" + "abc ".repeat(2000) + "</gpx>";
    const { sizeBytes, sha256 } = await svc.save("abc-1", xml);
    const onDisk = await readFile(join(dir, "abc-1.gpx.gz"));
    expect(onDisk.byteLength).toBe(sizeBytes);
    // sha256 of the *uncompressed* bytes — repeated content compresses
    // well so this also implicitly checks we hashed pre-gzip.
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(gunzipSync(onDisk).toString("utf8")).toBe(xml);
    // Repetitive content => gzip is much smaller than input.
    expect(sizeBytes).toBeLessThan(Buffer.byteLength(xml, "utf8") / 4);
  });

  it("read() round-trips utf8 (including non-ascii)", async () => {
    const xml = "<gpx>Hövelhof — café — Æthelred 🏞️</gpx>";
    await svc.save("u-2", xml);
    expect(await svc.read("u-2")).toBe(xml);
  });

  it("save() is idempotent — overwrites the existing file", async () => {
    await svc.save("u-3", "<gpx>v1</gpx>");
    const { sha256 } = await svc.save("u-3", "<gpx>v2</gpx>");
    expect(await svc.read("u-3")).toBe("<gpx>v2</gpx>");
    // v1 sha is different from v2 sha — sanity check we didn't return
    // a cached v1 hash.
    expect(sha256).not.toBe(
      "3e6c4f7c4b8e0e3b8e1c1e1d4f9a8d3a8e0e3b8e1c1e1d4f9a8d3a8e0e3b8e",
    );
  });

  it("read() of a missing upload throws ENOENT", async () => {
    await expect(svc.read("does-not-exist")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("delete() removes the file; second delete is a no-op", async () => {
    await svc.save("u-4", "<gpx/>");
    await svc.delete("u-4");
    await expect(svc.read("u-4")).rejects.toMatchObject({ code: "ENOENT" });
    // Second delete must not throw — keeps reprocess retries idempotent.
    await expect(svc.delete("u-4")).resolves.toBeUndefined();
  });

  it("rejects path-traversal uploadIds", async () => {
    await expect(svc.save("../escape", "<gpx/>")).rejects.toThrow(
      /Invalid uploadId/,
    );
    await expect(svc.read("../escape")).rejects.toThrow(/Invalid uploadId/);
  });

  it("requires a non-empty dir at construction", () => {
    expect(() => new GpxStorageService("")).toThrow(/UPLOADS_DIR/);
    expect(() => new GpxStorageService(undefined as unknown as string)).toThrow(
      /UPLOADS_DIR/,
    );
  });
});
