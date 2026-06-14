// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  type PrecomputeKind,
  PrecomputeSummary,
  type RetriggerOneRequest,
  type RetriggerStaleRequest,
  RetriggerStaleResponse,
  StaleCacheListResponse,
} from "@gctp/shared/admin";
import {
  AuthUser,
  type LoginInput,
  type RegisterInput,
} from "@gctp/shared/auth";
import {
  CacheDTO,
  CachesSummaryResponse,
  type CachesQuery,
} from "@gctp/shared/caches";
import type { BoundingBox } from "@gctp/shared/geo";
import { LanduseResponse, type LanduseKind } from "@gctp/shared/landuse";
import { LanduseProfilesResponse } from "@gctp/shared/landuse-profiles";
import { Leg } from "@gctp/shared/routing";
import {
  ParkingFacilitiesResponse,
  type ParkingAccessChip,
  type ParkingFeeFilter,
} from "@gctp/shared/parking-facilities";
import {
  ClusterCandidatesResponse,
  type ExplainClusterInput,
  ExplainClusterResponse,
  type ParkingOptionsInput,
  ParkingOptionsResponse,
  type PlanInput,
  type PlanLoopInput,
  PlanResult,
  type PurgeBogusInput,
  PurgeBogusResponse,
  type SaveTourInput,
  SavedTourDetail,
  SavedTourSummary,
  type TestRouteInput,
  TestRouteResponse,
  type ViaRouteInput,
  ViaRouteResponse,
  type WalkingGraphInput,
  WalkingGraphResponse,
} from "@gctp/shared/tours";
import { z } from "zod";

/**
 * Hand-written typed client. The OpenAPI-generated client lands once the API
 * surface stabilizes; in the meantime, parse responses through the shared zod
 * schemas so a server change that breaks the wire surface fails loudly here.
 *
 * All paths are relative — Vite's dev server proxies /api → http://localhost:3030
 * (see vite.config.ts). The built static bundle calls the same prefix; deploy
 * the API behind a reverse proxy that strips /api in production.
 */
const BASE = "/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${status} ${url}: ${body.slice(0, 200)}`);
  }
}

/**
 * Set by the app shell (AuthProvider) to centralise the 401 → /login redirect
 * (auth design §12). Invoked for any authenticated request that comes back 401 —
 * EXCEPT the `/auth/*` endpoints, where a 401 is an expected outcome (anonymous
 * `/auth/me`, bad-credentials `/auth/login`) the caller handles itself rather
 * than bouncing the user.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/** Non-httpOnly CSRF cookie + the header it's echoed in (double-submit, §4). */
const CSRF_COOKIE = "csrf";
const CSRF_HEADER = "X-CSRF-Token";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Read a non-httpOnly cookie by name. Returns null in non-browser test envs. */
function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split("; ")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  // Double-submit CSRF: echo the readable `csrf` cookie on state-changing calls.
  // GETs are exempt server-side, so don't bother attaching the header there.
  if (MUTATING_METHODS.has(method)) {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers.set(CSRF_HEADER, token);
  }
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    // Carry the httpOnly `sid` session cookie on every call. Same-origin in
    // prod (the reverse proxy serves API + app under one origin); cross-origin
    // in dev, where Vite proxies /api → the API and `include` is required.
    credentials: "include",
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) {
      onUnauthorized?.();
    }
    throw new ApiError(res.status, path, text);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export interface ListCachesParams {
  center: [number, number];
  radiusM: number;
  types?: CachesQuery["types"];
  attributes?: CachesQuery["attributes"];
  excludeFound?: boolean;
  contexts?: readonly LanduseKind[];
  /** FR-I10 — include caches the owner has temporarily disabled. Default false. */
  includeDisabled?: boolean;
  /** FR-I10 — include archived caches. Default false. */
  includeArchived?: boolean;
  /** Exclude Mystery caches that have no solved coordinate. Default false. */
  solvedMysteriesOnly?: boolean;
  /** FR-SF2 Multi sub-type filter ("all" = no narrowing). Server-side. */
  multiSubtype?: CachesQuery["multiSubtype"];
  /** FR-SF6 — hide caches requiring special equipment. Server-side. */
  hideToolCaches?: boolean;
}

export async function listCaches(
  params: ListCachesParams,
  signal?: AbortSignal,
) {
  const search = new URLSearchParams();
  search.set("lng", String(params.center[0]));
  search.set("lat", String(params.center[1]));
  search.set("radiusM", String(params.radiusM));
  for (const t of params.types ?? []) search.append("types", t);
  if (params.attributes && params.attributes.length > 0) {
    search.set("attributes", JSON.stringify(params.attributes));
  }
  if (params.excludeFound) search.set("excludeFound", "true");
  for (const c of params.contexts ?? []) search.append("contexts", c);
  if (params.includeDisabled) search.set("includeDisabled", "true");
  if (params.includeArchived) search.set("includeArchived", "true");
  if (params.solvedMysteriesOnly) search.set("solvedMysteriesOnly", "true");
  if (params.multiSubtype && params.multiSubtype !== "all")
    search.set("multiSubtype", params.multiSubtype);
  if (params.hideToolCaches) search.set("hideToolCaches", "true");
  const raw = await request<unknown>(`/caches?${search.toString()}`, {
    signal,
  });
  return CachesSummaryResponse.parse(raw);
}

/**
 * Full detail for a single cache — the popup-only fields (`difficulty`,
 * `terrain`, `attributeIds`, `descriptionHints`, …) that the lean `/caches`
 * list omits. Fetched lazily when a cache popup opens. Owner-scoped server-side.
 */
export async function fetchCacheDetail(id: number) {
  const raw = await request<unknown>(`/caches/${id}`);
  return CacheDTO.parse(raw);
}

export interface ListLanduseParams {
  bbox: BoundingBox;
  kinds?: readonly LanduseKind[];
}

export async function listLanduse(params: ListLanduseParams) {
  const search = new URLSearchParams();
  search.set("minLng", String(params.bbox.minLng));
  search.set("minLat", String(params.bbox.minLat));
  search.set("maxLng", String(params.bbox.maxLng));
  search.set("maxLat", String(params.bbox.maxLat));
  for (const k of params.kinds ?? []) search.append("kinds", k);
  const raw = await request<unknown>(`/landuse?${search.toString()}`);
  return LanduseResponse.parse(raw);
}

export interface ListParkingFacilitiesParams {
  bbox: BoundingBox;
  access?: readonly ParkingAccessChip[];
  fee?: ParkingFeeFilter;
}

export async function listParkingFacilities(
  params: ListParkingFacilitiesParams,
) {
  const search = new URLSearchParams();
  search.set("minLng", String(params.bbox.minLng));
  search.set("minLat", String(params.bbox.minLat));
  search.set("maxLng", String(params.bbox.maxLng));
  search.set("maxLat", String(params.bbox.maxLat));
  for (const a of params.access ?? []) search.append("access", a);
  if (params.fee && params.fee !== "any") search.set("fee", params.fee);
  const raw = await request<unknown>(
    `/parking-facilities?${search.toString()}`,
  );
  return ParkingFacilitiesResponse.parse(raw);
}

export async function listLanduseProfiles() {
  const raw = await request<unknown>("/landuse-profiles");
  return LanduseProfilesResponse.parse(raw);
}

export interface UploadGpxResult {
  uploadId: string;
  cachesUpserted: number;
  waypointsInserted: number;
  findsRecorded: number;
  warnings: string[];
  /** FR-I11 — per-upload summary. */
  stats: {
    total: number;
    byType: Record<string, number>;
    disabled: number;
    archived: number;
    new: number;
    updated: number;
    stale: number;
    exportedAt: string | null;
  };
  /** Auto-detected as a Groundspeak "My Finds" Pocket Query. */
  myFinds: boolean;
  /**
   * FR-I12 — true when this byte-identical file was already uploaded and
   * processing was skipped (counts are all zero, `uploadId` points at the
   * existing upload). Re-call with `force: true` to process it anyway.
   */
  duplicate: boolean;
}

export interface UploadGpxOptions {
  /** When true, every cache in the upload is also marked as found. */
  markAsFound?: boolean;
  /** FR-I12 — bypass the duplicate-file skip and re-process anyway. */
  force?: boolean;
  /**
   * When true, the file carries the user's SOLVED (corrected) coordinates.
   * Every cache in it is marked solved and its planning location set to the
   * file's coords; the original posted coord is preserved.
   */
  solvedCoordinates?: boolean;
}

export async function uploadGpx(
  file: File,
  opts: UploadGpxOptions = {},
): Promise<UploadGpxResult> {
  const form = new FormData();
  form.append("file", file);
  if (opts.markAsFound) form.append("markAsFound", "true");
  if (opts.force) form.append("force", "true");
  if (opts.solvedCoordinates) form.append("solvedCoordinates", "true");
  return request<UploadGpxResult>("/gpx/upload", {
    method: "POST",
    body: form,
  });
}

export function markCacheFound(cacheId: number): Promise<{ created: boolean }> {
  return request(`/caches/${cacheId}/finds`, { method: "POST" });
}

export function unmarkCacheFound(
  cacheId: number,
): Promise<{ removed: boolean }> {
  return request(`/caches/${cacheId}/finds`, { method: "DELETE" });
}

/**
 * Remove a cache's solved coordinate, reverting its planning location to the
 * posted coord. `cleared: false` when the cache had no solved coordinate.
 */
export function clearSolvedCoordinates(
  cacheId: number,
): Promise<{ cleared: boolean }> {
  return request(`/caches/${cacheId}/solved-coordinates`, { method: "DELETE" });
}

export async function discoverClusters(input: PlanInput) {
  const raw = await request<unknown>("/tours/clusters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return ClusterCandidatesResponse.parse(raw);
}

export async function planLoop(input: PlanLoopInput) {
  const raw = await request<unknown>("/tours/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return PlanResult.parse(raw);
}

export async function fetchParkingOptions(input: ParkingOptionsInput) {
  const raw = await request<unknown>("/tours/parking-options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return ParkingOptionsResponse.parse(raw);
}

export async function explainSelection(input: ExplainClusterInput) {
  const raw = await request<unknown>("/tours/clusters/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return ExplainClusterResponse.parse(raw);
}

export async function fetchWalkingGraph(input: WalkingGraphInput) {
  const raw = await request<unknown>("/tours/walking-graph", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return WalkingGraphResponse.parse(raw);
}

/**
 * Cache-first OSRM walking leg (route geometry + meters + seconds) between two
 * of the current user's caches. Used by the walking-graph debug overlay to show
 * the real shortest path for a selected edge. Returns `null` when OSRM can't
 * route the pair. First call per pair hits OSRM once; the server persists it to
 * `route_legs`, so repeats are a cheap DB read.
 */
export async function fetchLeg(
  fromId: number,
  toId: number,
  profile = "foot",
): Promise<Leg | null> {
  const raw = await request<unknown>(
    `/routing/leg/${fromId}/${toId}?profile=${profile}`,
  );
  return Leg.nullable().parse(raw);
}

export async function testOsrmRoute(input: TestRouteInput) {
  const raw = await request<unknown>("/tours/route/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return TestRouteResponse.parse(raw);
}

/**
 * Live OSRM `from → via → to` foot route. Throttle on the caller side
 * during a drag interaction and pass an `AbortSignal` so out-of-order
 * responses can be cancelled — the latest dragged position is the only
 * one that should ultimately paint.
 */
export async function fetchViaRoute(
  input: ViaRouteInput,
  signal?: AbortSignal,
) {
  const raw = await request<unknown>("/tours/legs/via-route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  return ViaRouteResponse.parse(raw);
}

export async function purgeBogusWalkingCells(input: PurgeBogusInput) {
  const raw = await request<unknown>("/tours/walking-graph/purge-bogus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return PurgeBogusResponse.parse(raw);
}

// ─── Saved tours (M6-γ) ─────────────────────────────────────────────────────

/** Persist the just-planned tour (FR-P1). Returns the saved tour's full detail. */
export async function saveTour(input: SaveTourInput): Promise<SavedTourDetail> {
  const raw = await request<unknown>("/tours", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return SavedTourDetail.parse(raw);
}

/** The caller's saved tours as lean summaries, newest first (FR-P2.1). */
export async function listTours(): Promise<SavedTourSummary[]> {
  const raw = await request<unknown>("/tours");
  return z.array(SavedTourSummary).parse(raw);
}

/** Open one saved tour in full detail so it re-renders without replanning (FR-P2.2). */
export async function getTour(id: string): Promise<SavedTourDetail> {
  const raw = await request<unknown>(`/tours/${id}`);
  return SavedTourDetail.parse(raw);
}

/** Rename a saved tour (FR-P2.3). */
export async function renameTour(
  id: string,
  name: string,
): Promise<SavedTourDetail> {
  const raw = await request<unknown>(`/tours/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return SavedTourDetail.parse(raw);
}

/** Delete a saved tour (FR-P2.3). */
export async function deleteTour(id: string): Promise<void> {
  await request<void>(`/tours/${id}`, { method: "DELETE" });
}

// ─── Admin: precompute dashboard ──────────────────────────────────────────

export async function fetchPrecomputeSummary() {
  const raw = await request<unknown>("/admin/precompute/summary");
  return PrecomputeSummary.parse(raw);
}

export async function fetchStaleCaches(
  kind: PrecomputeKind,
  opts: { limit?: number; offset?: number } = {},
) {
  const qs = new URLSearchParams({ kind });
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.offset !== undefined) qs.set("offset", String(opts.offset));
  const raw = await request<unknown>(
    `/admin/precompute/stale?${qs.toString()}`,
  );
  return StaleCacheListResponse.parse(raw);
}

export async function retriggerStale(input: RetriggerStaleRequest) {
  const raw = await request<unknown>("/admin/precompute/retrigger-stale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return RetriggerStaleResponse.parse(raw);
}

export async function retriggerOne(input: RetriggerOneRequest) {
  return request<{ jobId: string }>("/admin/precompute/retrigger-one", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

// ─── Auth (M6-β) ───────────────────────────────────────────────────────────

/**
 * Self-service registration; the server establishes a session on success. The
 * optional `turnstileToken` is the Cloudflare Turnstile response (FR-P5); the
 * server requires it only when captcha is configured.
 */
export async function register(
  input: RegisterInput,
  turnstileToken?: string,
): Promise<AuthUser> {
  const raw = await request<unknown>("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, turnstileToken }),
  });
  return AuthUser.parse(raw);
}

/** Password login; the server sets the `sid` + `csrf` cookies on success. */
export async function login(input: LoginInput): Promise<AuthUser> {
  const raw = await request<unknown>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return AuthUser.parse(raw);
}

/** Logout; clears the cookies and deletes the Valkey session server-side. */
export async function logout(): Promise<void> {
  await request<void>("/auth/logout", { method: "POST" });
}

/**
 * The current session's user, or `null` when unauthenticated. `/auth/me` answers
 * 401 for an anonymous caller — a normal "logged out" signal here, not an error,
 * so swallow it and let callers treat null as unauthenticated.
 */
export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const raw = await request<unknown>("/auth/me");
    return AuthUser.parse(raw);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}
