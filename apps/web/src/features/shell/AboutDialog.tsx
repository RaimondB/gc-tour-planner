// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { type JSX } from "react";

import { appIdentity, resolveAppEnv } from "../../lib/app-identity.js";

/**
 * Small "About" modal reachable from the header menu. Its job beyond vanity:
 * surface the build timestamp baked into the bundle (vite.config.ts `define`)
 * so an installed, prompt-strategy PWA can be confirmed to actually be running
 * the latest deploy — rather than silently serving the precached old SW. Match
 * this build time against the deploy you expect; if it's stale, take the
 * "A new version is available" reload (or reinstall) and re-check here.
 */
const env = resolveAppEnv(import.meta.env.VITE_APP_ENV);
const identity = appIdentity(env);

function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function AboutDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="about-backdrop" onClick={onClose} role="presentation">
      <div
        className="about-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="About this app"
        aria-modal="true"
      >
        <header className="about-dialog__header">
          <h2>About</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <dl className="about-dialog__facts">
          <dt>App</dt>
          <dd>{identity.name}</dd>
          <dt>Environment</dt>
          <dd>{env.toUpperCase()}</dd>
          <dt>Build</dt>
          <dd>
            <time dateTime={__APP_BUILD_TIME__}>
              {formatBuildTime(__APP_BUILD_TIME__)}
            </time>
          </dd>
        </dl>
        <p className="about-dialog__hint">
          On an installed app, an out-of-date build means the service worker is
          still serving a cached version — take the “A new version is available”
          reload (or reinstall) and re-open this dialog to confirm.
        </p>
      </div>
    </div>
  );
}
