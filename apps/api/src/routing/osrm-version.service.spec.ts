// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OsrmVersionService,
  UNKNOWN_OSRM_VERSION,
} from "./osrm-version.service.js";

describe("OsrmVersionService", () => {
  let dir: string;
  const originalEnv = process.env.OSRM_VERSION_FILE;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "osrm-version-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.OSRM_VERSION_FILE;
    } else {
      process.env.OSRM_VERSION_FILE = originalEnv;
    }
  });

  it("returns the file contents trimmed of whitespace", () => {
    const path = join(dir, "osrm-version.txt");
    writeFileSync(path, "deadbeefcafe1234\n");
    process.env.OSRM_VERSION_FILE = path;
    const svc = new OsrmVersionService();
    svc.onModuleInit();
    expect(svc.getVersion()).toBe("deadbeefcafe1234");
  });

  it("falls back to UNKNOWN when the file is missing", () => {
    process.env.OSRM_VERSION_FILE = join(dir, "missing.txt");
    const svc = new OsrmVersionService();
    svc.onModuleInit();
    expect(svc.getVersion()).toBe(UNKNOWN_OSRM_VERSION);
  });

  it("falls back to UNKNOWN when the file is empty", () => {
    const path = join(dir, "osrm-version.txt");
    writeFileSync(path, "   \n");
    process.env.OSRM_VERSION_FILE = path;
    const svc = new OsrmVersionService();
    svc.onModuleInit();
    expect(svc.getVersion()).toBe(UNKNOWN_OSRM_VERSION);
  });

  it("picks up an extract rebuild without a restart", () => {
    const path = join(dir, "osrm-version.txt");
    writeFileSync(path, "v1-aaaaaaaaaaaaaaaa\n");
    process.env.OSRM_VERSION_FILE = path;
    const svc = new OsrmVersionService();
    svc.onModuleInit();
    expect(svc.getVersion()).toBe("v1-aaaaaaaaaaaaaaaa");

    writeFileSync(path, "v2-bbbbbbbbbbbbbbbb\n");
    expect(svc.getVersion()).toBe("v2-bbbbbbbbbbbbbbbb");
  });
});
