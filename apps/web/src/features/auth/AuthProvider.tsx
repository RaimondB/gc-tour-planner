// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type JSX,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthUser, LoginInput, RegisterInput } from "@gctp/shared/auth";
import * as api from "../../lib/api.js";

/** React Query key for the `GET /auth/me` session probe. */
export const AUTH_ME_QUERY_KEY = ["auth", "me"] as const;

// The last principal we saw, mirrored to localStorage. A cold *offline* launch
// (e.g. the installed PWA opened in the field) can't reach `/auth/me`; without a
// fallback the probe errors, the app treats the user as logged out, and the `/`
// guard bounces to a login that can't complete offline — trapping them before
// their cached tours (FR-W3). Storing the user's own identity on their own
// device matches the privacy posture already accepted for the saved-tour SW
// cache (ADR-0028). Cleared on a clean sign-out.
const CACHED_USER_KEY = "gctp:auth:last-user";

function readCachedUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function writeCachedUser(user: AuthUser | null): void {
  try {
    if (user) localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHED_USER_KEY);
  } catch {
    /* storage unavailable (private mode, quota) — best effort */
  }
}

export type AuthStatus = "pending" | "authenticated" | "unauthenticated";

export interface AuthContextValue {
  /** The signed-in principal, or null when anonymous. */
  user: AuthUser | null;
  /** "pending" only while the initial `/auth/me` probe is in flight. */
  status: AuthStatus;
  isAuthenticated: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput, turnstileToken?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Auth context backed by `GET /auth/me` (auth design §12). The session cookie is
 * the source of truth; this query just mirrors it into React so routes and the
 * header can react to sign-in / sign-out without a page reload.
 */
export function AuthProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const qc = useQueryClient();
  const meQuery = useQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: () => api.fetchMe(),
    // A clean "logged out" (null) is a valid answer, not a failure to retry.
    retry: false,
    staleTime: 5 * 60_000,
  });

  // Mirror the live answer to localStorage: persist a real principal, and clear
  // it on a clean logout (`null`). An *errored* probe leaves the cache intact so
  // the offline fallback below can still recover the session.
  useEffect(() => {
    if (meQuery.data) writeCachedUser(meQuery.data);
    else if (meQuery.data === null) writeCachedUser(null);
  }, [meQuery.data]);

  const login = useCallback(
    async (input: LoginInput) => {
      const user = await api.login(input);
      qc.setQueryData(AUTH_ME_QUERY_KEY, user);
    },
    [qc],
  );

  const register = useCallback(
    async (input: RegisterInput, turnstileToken?: string) => {
      const user = await api.register(input, turnstileToken);
      qc.setQueryData(AUTH_ME_QUERY_KEY, user);
    },
    [qc],
  );

  const logout = useCallback(async () => {
    await api.logout();
    qc.setQueryData(AUTH_ME_QUERY_KEY, null);
    // Evict every owner-scoped cache entry so the next user never sees the
    // previous one's caches/tours flash before their own load.
    await qc.invalidateQueries();
  }, [qc]);

  const value = useMemo<AuthContextValue>(() => {
    const liveUser = meQuery.data ?? null;
    // Offline + the probe errored before any answer this session (cold launch):
    // restore the last principal we saw rather than treating the failure as a
    // sign-out. Gate ONLY on `isError`, never on `online`: a clean 401 returns
    // `null` (not an error) so a genuine logout still becomes "unauthenticated",
    // while an errored probe keeps the cached user. Critically this must NOT
    // depend on `online` — otherwise the periodic `/api/health` probe flipping
    // online during a flaky startup would drop the fallback, flip status to
    // unauthenticated, bounce `/`→`/welcome`, and tear the map down mid-startup.
    const fallbackUser = meQuery.isError ? readCachedUser() : null;
    const user = liveUser ?? fallbackUser;
    const status: AuthStatus = meQuery.isPending
      ? "pending"
      : user
        ? "authenticated"
        : "unauthenticated";
    return {
      user,
      status,
      isAuthenticated: status === "authenticated",
      login,
      register,
      logout,
    };
  }, [
    meQuery.data,
    meQuery.isPending,
    meQuery.isError,
    login,
    register,
    logout,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
