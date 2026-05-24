// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { LanduseKind } from "@gctp/shared/landuse";

/**
 * Map an OSM way's tag bag onto one of our canonical landuse kinds.
 * Order matters: more specific tags win over generic ones. Returns null
 * for anything we don't render — caller skips the feature.
 */
export function classifyLanduse(
  tags: Readonly<Record<string, string>>,
): LanduseKind | null {
  const landuse = tags.landuse;
  if (landuse === "forest") return "forest";
  if (landuse === "park") return "park";
  if (landuse === "residential") return "residential";
  if (landuse === "farmland") return "farmland";
  if (landuse === "industrial") return "industrial";
  if (landuse === "meadow") return "meadow";
  if (landuse === "heath") return "heath";
  if (landuse === "scrub") return "scrub";

  const natural = tags.natural;
  if (natural === "wood") return "forest";
  if (natural === "water") return "water";
  if (natural === "wetland") return "wetland";
  if (natural === "heath") return "heath";
  if (natural === "scrub") return "scrub";

  const leisure = tags.leisure;
  if (leisure === "park") return "park";
  if (leisure === "nature_reserve") return "park";

  return null;
}
