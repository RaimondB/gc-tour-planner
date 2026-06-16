// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { SavedTourDetail } from "@gctp/shared/tours";

/**
 * Durable offline store for opened saved tours (FR-W3). A `SavedTourDetail`
 * carries everything needed to render a tour offline (route, pins, parking,
 * totals, snapshot flag), so mirroring it here lets the planner resume / switch
 * tours instantly offline — independent of the service-worker HTTP cache, which
 * is a best-effort revalidation layer, not the source of truth.
 *
 * A hand-rolled ~native wrapper rather than a dependency (idb/Dexie): the
 * surface is tiny, and the repo keeps its dep set lean (GPLv3-compat review).
 * Every call degrades to a no-op / null when IndexedDB is unavailable (private
 * mode, old browsers, jsdom) so callers never need to guard.
 */
const DB_NAME = "gctp-tours";
const DB_VERSION = 1;
const STORE = "tours";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // keyPath "id" — a SavedTourDetail is stored under its own tour id.
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Run `fn` inside a transaction, resolving its IDBRequest. Null-safe. */
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Mirror a freshly-fetched tour so it renders offline later. Best-effort. */
export async function cacheTourDetail(detail: SavedTourDetail): Promise<void> {
  await withStore("readwrite", (s) => s.put(detail));
}

/** Read a cached tour for instant offline render. Null if absent/unavailable. */
export async function readCachedTourDetail(
  id: string,
): Promise<SavedTourDetail | null> {
  const raw = await withStore<SavedTourDetail>("readonly", (s) => s.get(id));
  return raw ?? null;
}

/** Drop one cached tour (e.g. after delete). Best-effort. */
export async function deleteCachedTour(id: string): Promise<void> {
  await withStore("readwrite", (s) => s.delete(id));
}

/**
 * Keep only the tours whose ids are in `keepIds`, evicting the rest — used after
 * a My Tours refresh (deleted tours) and on logout (`keepIds = []`) so a cached
 * tour never outlives the account that owns it.
 */
export async function pruneCachedTours(
  keepIds: readonly string[],
): Promise<void> {
  const keep = new Set(keepIds);
  const ids = await withStore<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
  if (!ids) return;
  await Promise.all(
    ids
      .map((k) => String(k))
      .filter((id) => !keep.has(id))
      .map((id) => deleteCachedTour(id)),
  );
}
