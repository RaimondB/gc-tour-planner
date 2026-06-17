// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tiny pub/sub so the GPX download flow (lib, non-React) can tell the
 * `GpxDownloadToast` (React, mounted once above the router) that a file was
 * saved — without threading a callback through the two unrelated export call
 * sites. Only fired on the service-worker save path (the installed-PWA case
 * that has no browser download UI of its own); the desktop anchor download
 * already shows the browser's own download shelf, so no toast there.
 */
type Listener = (filename: string) => void;

const listeners = new Set<Listener>();

export function onGpxSaved(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function emitGpxSaved(filename: string): void {
  for (const fn of [...listeners]) fn(filename);
}
