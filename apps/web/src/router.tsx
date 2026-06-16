// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import App from "./App.js";
import type { AuthContextValue } from "./features/auth/AuthProvider.js";
import { AccountPage } from "./features/auth/AccountPage.js";
import { LoginPage } from "./features/auth/LoginPage.js";
import { RegisterPage } from "./features/auth/RegisterPage.js";
import { LandingPage } from "./features/landing/LandingPage.js";
import { MyToursPage } from "./features/tours/MyToursPage.js";

/** Router context — the live auth state, injected by `RouterProvider`. */
export interface RouterContext {
  auth: AuthContextValue;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

/** Protected app shell. Anonymous visitors bounce to /welcome before render. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthenticated) {
      throw redirect({ to: "/welcome" });
    }
  },
  component: App,
});

/** Public `/welcome` route — the marketing landing page for anonymous visitors. */
const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/welcome",
  component: LandingPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  component: RegisterPage,
});

/** Protected `/tours` route (M6-γ) — the My Tours list. */
const toursRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tours",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthenticated) {
      throw redirect({ to: "/login" });
    }
  },
  component: MyToursPage,
});

/** Protected `/account` route — set/change password (FR-P5a). */
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthenticated) {
      throw redirect({ to: "/welcome" });
    }
  },
  component: AccountPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  welcomeRoute,
  loginRoute,
  registerRoute,
  toursRoute,
  accountRoute,
]);

export const router = createRouter({
  routeTree,
  // The real auth value is supplied per-render by RouterProvider in main.tsx;
  // this placeholder only satisfies the initial type contract.
  context: { auth: undefined as unknown as AuthContextValue },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
