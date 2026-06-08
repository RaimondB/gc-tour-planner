// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import {
  clientIp,
  parseTrustProxy,
  trustCfFromEnv,
  type IpRequest,
} from "./client-ip.js";

const req = (over: Partial<IpRequest>): IpRequest => ({
  headers: {},
  ...over,
});

describe("clientIp", () => {
  const trust = { trustCfConnectingIp: true };
  const noTrust = { trustCfConnectingIp: false };

  it("uses CF-Connecting-IP when trusted", () => {
    expect(
      clientIp(
        req({ headers: { "cf-connecting-ip": "203.0.113.7" }, ip: "10.0.0.1" }),
        trust,
      ),
    ).toBe("203.0.113.7");
  });

  it("ignores CF-Connecting-IP when not trusted (spoofable post-tunnel)", () => {
    expect(
      clientIp(
        req({ headers: { "cf-connecting-ip": "1.2.3.4" }, ip: "10.0.0.1" }),
        noTrust,
      ),
    ).toBe("10.0.0.1");
  });

  it("falls back to req.ip (proxy-resolved) when no CF header", () => {
    expect(clientIp(req({ ip: "198.51.100.9" }), trust)).toBe("198.51.100.9");
  });

  it("falls back to the socket address as a last resort", () => {
    expect(
      clientIp(req({ socket: { remoteAddress: "192.0.2.5" } }), trust),
    ).toBe("192.0.2.5");
  });

  it("handles a header array", () => {
    expect(
      clientIp(
        req({ headers: { "cf-connecting-ip": ["203.0.113.7", "x"] } }),
        trust,
      ),
    ).toBe("203.0.113.7");
  });
});

describe("parseTrustProxy", () => {
  it("defaults to 1 (trust the immediate nginx hop)", () => {
    expect(parseTrustProxy(undefined)).toBe(1);
    expect(parseTrustProxy("")).toBe(1);
  });
  it("parses integers, booleans, and subnet strings", () => {
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("10.0.0.0/8")).toBe("10.0.0.0/8");
  });
});

describe("trustCfFromEnv", () => {
  const original = process.env.TRUST_CF_CONNECTING_IP;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUST_CF_CONNECTING_IP;
    else process.env.TRUST_CF_CONNECTING_IP = original;
  });

  it("defaults to true", () => {
    delete process.env.TRUST_CF_CONNECTING_IP;
    expect(trustCfFromEnv()).toBe(true);
  });
  it("is false for 0/false", () => {
    process.env.TRUST_CF_CONNECTING_IP = "0";
    expect(trustCfFromEnv()).toBe(false);
    process.env.TRUST_CF_CONNECTING_IP = "false";
    expect(trustCfFromEnv()).toBe(false);
  });
});
