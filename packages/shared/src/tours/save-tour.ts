// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";
import { PlanResult } from "./plan-result.js";

/**
 * Tour name: required, trimmed, 1–120 chars (FR-P1.2). Duplicate names are
 * allowed — the row id is the key. Shared by save (FR-P1) and rename (FR-P2).
 */
export const TourName = z.string().trim().min(1).max(120);
export type TourName = z.infer<typeof TourName>;

/**
 * `POST /tours` body (FR-P1). The client sends only the name plus the
 * PlanResult it just rendered; the server derives the typed columns
 * (start/parking points, totals, geom, score breakdown, cache ids) from the
 * PlanResult and bakes the cache snapshot itself (owner-scoped, at save time),
 * so there is no redundant or spoofable per-cache payload on the wire.
 */
export const SaveTourInput = z.object({
  name: TourName,
  plan: PlanResult,
});
export type SaveTourInput = z.infer<typeof SaveTourInput>;

/**
 * `PUT /tours/:id` body (FR-P2.4): overwrite an existing tour in place with a
 * re-planned / edited route. Identical shape to {@link SaveTourInput} — the
 * server re-derives the typed columns + cache snapshot exactly as on save, and
 * preserves the tour's `created_at`, share slug, and stored preview.
 */
export const UpdateTourInput = SaveTourInput;
export type UpdateTourInput = z.infer<typeof UpdateTourInput>;
