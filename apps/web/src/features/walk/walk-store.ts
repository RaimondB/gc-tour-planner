// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { WalkSession } from "./walk-session.js";

/**
 * Durable home of the active walk (FR-T18): written on every intent so a
 * reload, a killed PWA or a phone restart resumes the walk exactly. A separate
 * IndexedDB database from the tour cache; one record under a fixed key. Every
 * call degrades to a no-op / null without IndexedDB (private mode, jsdom).
 */
const DB_NAME = "gctp-walk";
const STORE = "session";
const KEY = "active";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
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

async function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveWalk(session: WalkSession): Promise<void> {
  await run("readwrite", (s) => s.put(session, KEY));
}

export async function loadWalk(): Promise<WalkSession | null> {
  return (await run<WalkSession>("readonly", (s) => s.get(KEY))) ?? null;
}

export async function clearWalk(): Promise<void> {
  await run("readwrite", (s) => s.delete(KEY));
}
