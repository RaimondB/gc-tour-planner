// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "./auth.config.js";
import { TurnstileService } from "./turnstile.service.js";

function configWith(turnstileSecret: string | null): AuthConfig {
  return {
    isProduction: false,
    devBypass: false,
    sessionSecret: "x",
    sessionTtlSeconds: 1,
    cookieSecure: false,
    cookieDomain: undefined,
    postLoginRedirect: "/",
    google: null,
    turnstileSecret,
  };
}

describe("TurnstileService", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("disabled (no secret)", () => {
    const svc = new TurnstileService(configWith(null));

    it("reports disabled", () => {
      expect(svc.enabled).toBe(false);
    });

    it("is a no-op even without a token (registration stays open)", async () => {
      await expect(svc.verify(undefined, "1.2.3.4")).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("enabled (secret set)", () => {
    const svc = new TurnstileService(configWith("secret-key"));

    it("reports enabled", () => {
      expect(svc.enabled).toBe(true);
    });

    it("rejects a missing token with 400 and never calls siteverify", async () => {
      await expect(svc.verify(undefined, "1.2.3.4")).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("passes when siteverify returns success", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
      await expect(svc.verify("tok", "1.2.3.4")).resolves.toBeUndefined();

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("siteverify");
      const body = (init.body as URLSearchParams).toString();
      expect(body).toContain("secret=secret-key");
      expect(body).toContain("response=tok");
      expect(body).toContain("remoteip=1.2.3.4");
    });

    it("omits remoteip when the IP is unknown", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
      await svc.verify("tok", "unknown");
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.body as URLSearchParams).toString()).not.toContain(
        "remoteip",
      );
    });

    it("rejects with 403 when verification fails", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ success: false, "error-codes": ["invalid-input"] }),
      });
      await expect(svc.verify("bad", "1.2.3.4")).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it("fails closed (503) when siteverify is unreachable", async () => {
      fetchMock.mockRejectedValue(new Error("network down"));
      await expect(svc.verify("tok", "1.2.3.4")).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it("fails closed (503) on a non-2xx siteverify response", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 });
      await expect(svc.verify("tok", "1.2.3.4")).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
