// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { SetMetadata, type CustomDecorator } from "@nestjs/common";

/**
 * Metadata key marking a route handler (or whole controller) as exempt from the
 * global {@link JwtAuthGuard}. The set of `@Public()` routes is a normative
 * security contract (FR-P11 / design §7) — adding one requires updating the
 * public-endpoint inventory and its assertion test in the same PR.
 */
export const IS_PUBLIC_KEY = "gctp:isPublic";

/** Exempt a route (or controller) from authentication. Use sparingly. */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);
