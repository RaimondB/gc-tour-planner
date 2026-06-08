// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type JSX,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthUser, LoginInput, RegisterInput } from "@gctp/shared/auth";
import * as api from "../../lib/api.js";

/** React Query key for the `GET /auth/me` session probe. */
export const AUTH_ME_QUERY_KEY = ["auth", "me"] as const;

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
    const user = meQuery.data ?? null;
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
  }, [meQuery.data, meQuery.isPending, login, register, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
