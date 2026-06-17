// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Build-time app identity per deployment environment. UAT carries a "(UAT)" name
 * suffix and badged icons so an installed UAT PWA is unmistakable next to prod;
 * production stays clean. Driven by the public `VITE_APP_ENV` build arg, which
 * defaults to "uat" (fail-safe — anything not explicitly "production" is treated
 * as UAT and shows the badge).
 *
 * Framework-free and takes the raw env string as an argument (no `import.meta`),
 * so `vite.config.ts` (Node) and the unit test can both use it.
 */

export type AppEnv = "production" | "uat";

export function resolveAppEnv(raw: string | undefined): AppEnv {
  return raw?.trim() === "production" ? "production" : "uat";
}

export interface AppIdentity {
  /** Suffix appended to icon filenames (e.g. "pwa-512-uat.png"). "" in prod. */
  iconSuffix: string;
  /** PWA manifest `name`. */
  name: string;
  /** PWA manifest `short_name` + iOS home-screen label. */
  shortName: string;
  /** Browser tab `<title>`. */
  title: string;
}

export function appIdentity(env: AppEnv): AppIdentity {
  if (env === "production") {
    return {
      iconSuffix: "",
      name: "gc-tour-planner",
      shortName: "GC Tour",
      title: "gc-tour-planner",
    };
  }
  return {
    iconSuffix: "-uat",
    name: "gc-tour-planner (UAT)",
    shortName: "GC Tour (UAT)",
    title: "gc-tour-planner (UAT)",
  };
}
