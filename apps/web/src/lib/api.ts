// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { CachesResponse, type CachesQuery } from "@gctp/shared/caches";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, path, text);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export interface ListCachesParams {
  center: [number, number];
  radiusM: number;
  types?: CachesQuery["types"];
  attributes?: CachesQuery["attributes"];
  excludeFound?: boolean;
}

export async function listCaches(params: ListCachesParams) {
  const search = new URLSearchParams();
  search.set("lng", String(params.center[0]));
  search.set("lat", String(params.center[1]));
  search.set("radiusM", String(params.radiusM));
  for (const t of params.types ?? []) search.append("types", t);
  if (params.attributes && params.attributes.length > 0) {
    search.set("attributes", JSON.stringify(params.attributes));
  }
  if (params.excludeFound) search.set("excludeFound", "true");
  const raw = await request<unknown>(`/caches?${search.toString()}`);
  return CachesResponse.parse(raw);
}

export interface UploadGpxResult {
  uploadId: string;
  cachesUpserted: number;
  waypointsInserted: number;
  findsRecorded: number;
  warnings: string[];
}

export interface UploadGpxOptions {
  /** When true, every cache in the upload is also marked as found. */
  markAsFound?: boolean;
}

export async function uploadGpx(
  file: File,
  opts: UploadGpxOptions = {},
): Promise<UploadGpxResult> {
  const form = new FormData();
  form.append("file", file);
  if (opts.markAsFound) form.append("markAsFound", "true");
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
