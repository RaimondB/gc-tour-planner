// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, type JSX } from "react";
import { useConnectivityStatus } from "./ConnectivityProvider.js";

/**
 * When the connectivity probe sees an edge auth gate (Cloudflare Access) answer
 * with a login redirect — the session lapsed, we're NOT offline — show a blocking
 * "reconnect" overlay instead of the misleading "you're offline" UI.
 *
 * Reconnecting must reach the edge so Access can log the user back in. But the
 * service worker serves the precached app shell for navigations (`navigateFallback`),
 * so a plain reload never reaches Access. We therefore unregister the SW first,
 * then reload: that navigation hits the network, Access challenges, and after
 * login the SW re-registers. This is generic (any edge auth), not Cloudflare-specific.
 */
export function SessionExpiredGate(): JSX.Element | null {
  const status = useConnectivityStatus();
  const [reconnecting, setReconnecting] = useState(false);

  if (status !== "auth") return null;

  const reconnect = async (): Promise<void> => {
    setReconnecting(true);
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
    } catch {
      // Best effort — reload anyway; worst case the SW serves the shell again
      // and the overlay reappears.
    }
    window.location.reload();
  };

  return (
    <div
      className="session-expired"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
    >
      <div className="session-expired__card">
        <h2 id="session-expired-title">Session expired</h2>
        <p>
          Your secure session timed out. Reconnect to sign in again — your saved
          tours are safe.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() => void reconnect()}
          disabled={reconnecting}
        >
          {reconnecting ? "Reconnecting…" : "Reconnect"}
        </button>
      </div>
    </div>
  );
}
