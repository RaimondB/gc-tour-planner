// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchMe,
  login,
  logout,
  setUnauthorizedHandler,
} from "./api.js";

const USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "user@example.com",
  displayName: "Tester",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The (init) of the most recent fetch call. */
function lastInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  return fetchMock.mock.calls.at(-1)![1] as RequestInit;
}

/** Expire every cookie in the jsdom jar so tests don't leak state. */
function clearCookies(): void {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]!.trim();
    if (name) {
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    }
  }
}

describe("auth api client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    clearCookies();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
  });

  it("login posts credentials and parses the AuthUser", async () => {
    fetchMock.mockResolvedValue(jsonResponse(USER));
    const user = await login({ email: USER.email, password: "hunter2pass" });

    expect(user).toEqual(USER);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    // Always sends the session cookie.
    expect(init.credentials).toBe("include");
  });

  it("attaches the X-CSRF-Token header from the csrf cookie on mutations", async () => {
    document.cookie = "csrf=tok-abc123";
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await logout();

    const headers = lastInit(fetchMock).headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBe("tok-abc123");
  });

  it("omits the CSRF header when there is no csrf cookie", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await logout();

    const headers = lastInit(fetchMock).headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBeNull();
  });

  it("fetchMe returns the user when authenticated", async () => {
    fetchMock.mockResolvedValue(jsonResponse(USER));
    await expect(fetchMe()).resolves.toEqual(USER);
  });

  it("fetchMe returns null on a 401 (anonymous) instead of throwing", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "no" }, 401));
    await expect(fetchMe()).resolves.toBeNull();
  });

  it("login surfaces a 401 as an ApiError without firing the interceptor", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(jsonResponse({ message: "bad creds" }, 401));

    await expect(
      login({ email: USER.email, password: "wrongpass1" }),
    ).rejects.toBeInstanceOf(ApiError);
    // /auth/* endpoints opt out of the global redirect.
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("fires the unauthorized handler on a 401 from a non-auth endpoint", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(jsonResponse({ message: "expired" }, 401));

    // listLanduseProfiles hits /landuse-profiles — an authenticated endpoint.
    const { listLanduseProfiles } = await import("./api.js");
    await expect(listLanduseProfiles()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
