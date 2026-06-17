// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createContext,
  useContext,
  useMemo,
  type JSX,
  type ReactNode,
} from "react";
import {
  useConnectivity,
  type Connectivity,
} from "../../lib/use-connectivity.js";

/**
 * App-wide connectivity. `useConnectivity()` runs ONE probe loop here (mounted
 * near the root) and every component reads the result via `useOnline()` /
 * `useRecheckConnectivity()` — so the header indicator, the offline banner, the
 * journey rail, and every online-only control react to the same source of truth
 * instead of each spinning up its own `/api/health` poll.
 */
interface ConnectivityContextValue {
  status: Connectivity;
  online: boolean;
  recheck: () => void;
}

const ConnectivityContext = createContext<ConnectivityContextValue | null>(
  null,
);

export function ConnectivityProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const { status, online, recheck } = useConnectivity();
  const value = useMemo<ConnectivityContextValue>(
    () => ({ status, online, recheck }),
    [status, online, recheck],
  );
  return (
    <ConnectivityContext.Provider value={value}>
      {children}
    </ConnectivityContext.Provider>
  );
}

function useConnectivityContext(): ConnectivityContextValue {
  const ctx = useContext(ConnectivityContext);
  if (!ctx) {
    throw new Error(
      "useOnline/useRecheckConnectivity must be used within a ConnectivityProvider",
    );
  }
  return ctx;
}

/** `true` when the server is reachable (authoritative `/api/health` probe). */
export function useOnline(): boolean {
  return useConnectivityContext().online;
}

/**
 * Full connectivity status. `"auth"` means an edge gate (Cloudflare Access)
 * needs a fresh session — distinct from being offline. See SessionExpiredGate.
 */
export function useConnectivityStatus(): Connectivity {
  return useConnectivityContext().status;
}

/** Force an immediate connectivity re-check (e.g. when basemap tiles fail). */
export function useRecheckConnectivity(): () => void {
  return useConnectivityContext().recheck;
}
