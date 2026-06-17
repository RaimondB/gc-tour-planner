// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { classifyProbe } from "./use-connectivity.js";

describe("classifyProbe", () => {
  it("treats a real HTTP response as online", () => {
    expect(classifyProbe({ type: "basic", status: 200 })).toBe("online");
    expect(classifyProbe({ type: "cors", status: 200 })).toBe("online");
  });

  it("treats an opaque redirect (edge auth gate) as auth, not offline", () => {
    // Cloudflare Access answers an expired session with a cross-origin 302; with
    // redirect:"manual" the browser surfaces it as an opaque redirect.
    expect(classifyProbe({ type: "opaqueredirect", status: 0 })).toBe("auth");
  });

  it("treats 401/403 as auth", () => {
    expect(classifyProbe({ type: "basic", status: 401 })).toBe("auth");
    expect(classifyProbe({ type: "basic", status: 403 })).toBe("auth");
  });

  it("treats a status-0 non-redirect as offline", () => {
    expect(classifyProbe({ type: "error", status: 0 })).toBe("offline");
  });
});
