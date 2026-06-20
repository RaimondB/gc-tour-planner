// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { SetMetadata, type CustomDecorator } from "@nestjs/common";

/**
 * Metadata key marking a route handler (or whole controller) as authenticated
 * by a MACHINE credential (a bearer token) rather than the browser session
 * cookie. When present, the global {@link JwtAuthGuard} steps aside — it does
 * not look for a session and does not enforce CSRF (a bearer in `Authorization`
 * is not an ambient credential, so CSRF does not apply). A route-level guard
 * (`IngestAuthGuard`) then performs the real bearer check.
 *
 * This is deliberately NOT `@Public()`: machine routes are authenticated, just
 * by a different credential. They have their own normative inventory
 * (`machine-auth-inventory.spec.ts`) so the no-session surface cannot drift
 * silently, exactly as `@Public()` routes do (ADR-0033).
 */
export const IS_MACHINE_KEY = "gctp:isMachineAuth";

/** Mark a route (or controller) as machine-authenticated (bearer token). */
export const MachineAuth = (): CustomDecorator =>
  SetMetadata(IS_MACHINE_KEY, true);
