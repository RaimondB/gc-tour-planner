// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/** Minimal request shape needed to resolve the client IP (kept express-free for tests). */
export interface IpRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface ClientIpOptions {
  /**
   * Trust Cloudflare's `CF-Connecting-IP` header. TRUE while the app sits behind
   * the Cloudflare tunnel (the only ingress, so the header is set by CF and a
   * client cannot forge it). FALSE once the origin is directly reachable (no
   * tunnel) — there the header would be client-spoofable, so fall back to the
   * proxy-resolved `req.ip` (which needs Express `trust proxy` set).
   */
  trustCfConnectingIp: boolean;
}

/**
 * Resolve the real client IP for per-IP rate-limit keying (FR-P9, Gate 1.1).
 *
 * Without this the throttler keys on `req.ip`, which behind nginx is the proxy's
 * socket address — collapsing the per-IP cap into a single shared bucket. Prefer
 * the CF-set client IP when behind the tunnel; otherwise rely on Express
 * `trust proxy` having resolved `req.ip` to the nginx-appended client address.
 */
export function clientIp(req: IpRequest, opts: ClientIpOptions): string {
  if (opts.trustCfConnectingIp) {
    const cf = req.headers["cf-connecting-ip"];
    const ip = Array.isArray(cf) ? cf[0] : cf;
    if (ip) return ip.trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/** Read the CF-Connecting-IP trust flag from env (default ON; set `0`/`false` once the tunnel is removed). */
export function trustCfFromEnv(): boolean {
  const v = process.env.TRUST_CF_CONNECTING_IP;
  return v !== "0" && v?.toLowerCase() !== "false";
}

/**
 * Parse the `TRUST_PROXY` env into an Express `trust proxy` value. Default `1`
 * trusts the single immediate hop (nginx) so `req.ip` is the real client and is
 * not spoofable via an inbound `X-Forwarded-For` (nginx appends the true peer).
 * Set a higher integer for more in-front hops, or `true`/a subnet string.
 */
export function parseTrustProxy(
  raw: string | undefined,
): number | boolean | string {
  if (raw === undefined || raw === "") return 1;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  return Number.isInteger(n) ? n : raw;
}
