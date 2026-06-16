// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { type JSX } from "react";
import { WifiOff } from "lucide-react";
import { useOnline } from "./ConnectivityProvider.js";

/**
 * Ambient offline indicator for any header (`App`, `MyToursPage`, `AccountPage`).
 * Renders nothing while online; offline it shows a `WifiOff` chip announced to
 * assistive tech via `role="status"`. The "why" lives in the full-width
 * `OfflineBanner`; this is the at-a-glance signal that survives on mobile (where
 * hover tooltips never show). Self-contained — drop `<OfflineBadge />` anywhere
 * under the `ConnectivityProvider`.
 */
export function OfflineBadge(): JSX.Element | null {
  const online = useOnline();
  if (online) return null;
  return (
    <span
      className="offline-badge"
      role="status"
      aria-label="Offline. Planning is unavailable; saved tours still open."
    >
      <WifiOff size={16} aria-hidden="true" />
      <span className="offline-badge__label">Offline</span>
    </span>
  );
}

/**
 * Full-width, persistent offline banner. The primary, mobile-safe explanation of
 * why online-only controls are disabled. Renders nothing while online.
 */
export function OfflineBanner(): JSX.Element | null {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="offline-banner" role="status">
      <WifiOff size={16} aria-hidden="true" />
      <span>
        You’re offline. Planning is unavailable — your saved tours still open.
      </span>
    </div>
  );
}
