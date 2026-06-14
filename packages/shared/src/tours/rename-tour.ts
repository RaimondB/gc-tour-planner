// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { TourName } from "./save-tour.js";

/** `PATCH /tours/:id` body (FR-P2.3) — rename only in M6. */
export const RenameTourInput = z.object({
  name: TourName,
});
export type RenameTourInput = z.infer<typeof RenameTourInput>;
