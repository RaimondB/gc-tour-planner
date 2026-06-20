// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Geo, Routing } from "@gctp/shared";
import type { OsrmLeg } from "../../../routing/osrm.client.js";
import { distanceMeters, makeEquirectangular } from "./equirectangular.js";

/** A routed leg with the alternatives the picker considered + the selected one. */
export type LegWithAlternatives = Routing.Leg & {
  alternatives: OsrmLeg[];
  selectedIndex: number;
};

const PROFILE: Routing.RoutingProfile = "foot";
/** Walking speed (m/s, ~5 km/h) for the tiny synthesized co-located legs. */
const WALKING_MPS = 1.4;

/**
 * Expand a route computed over co-location *representatives* back to its real
 * member stops. Pass-2 ran TSP / trim / parking / per-leg OSRM on one rep per
 * group (see `collapseColocated`); here each group becomes its members
 * (contiguous, in the order `members()` gives), with the real OSRM legs between
 * groups and a tiny synthesized leg between consecutive co-located members.
 *
 * Invariants (asserted in tests): every emitted leg carries ≥1 alternative
 * (PlanLeg requires it — a co-located leg is its own), and
 * `allLegs.length === orderedIds.length + 1`.
 */
export function expandColocatedRoute(
  reps: readonly number[],
  members: (repId: number) => number[],
  coordOf: (id: number) => [number, number],
  legs: {
    parkingToFirst: LegWithAlternatives;
    interCacheLegs: readonly LegWithAlternatives[];
    lastToParking: LegWithAlternatives;
  },
): { orderedIds: number[]; allLegs: LegWithAlternatives[] } {
  const zeroLeg = (from: number, to: number): LegWithAlternatives => {
    const a = coordOf(from);
    const b = coordOf(to);
    // A few metres between co-located stops — the cheap local equirectangular
    // projection is more than accurate enough (no haversine trig needed).
    const m = distanceMeters(
      { x: 0, y: 0 },
      makeEquirectangular(a[0], a[1]).project(b[0], b[1]),
    );
    const seconds = m / WALKING_MPS;
    const geometry: Geo.GeoJsonLineString = {
      type: "LineString",
      coordinates: [a, b],
    };
    return {
      fromCacheId: from,
      toCacheId: to,
      profile: PROFILE,
      meters: m,
      seconds,
      geometry,
      // PlanLeg requires ≥1 alternative; a co-located leg is its own.
      alternatives: [{ meters: m, seconds, geometry }],
      selectedIndex: 0,
    };
  };

  const orderedIds: number[] = [];
  const allLegs: LegWithAlternatives[] = [];
  for (let gi = 0; gi < reps.length; gi += 1) {
    const groupMembers = members(reps[gi]!);
    // Leg arriving at this group's first member: parking for the first group,
    // otherwise the real inter-group leg relabelled from the previous group's
    // last member.
    if (gi === 0) {
      allLegs.push({ ...legs.parkingToFirst, toCacheId: groupMembers[0]! });
    } else {
      const prev = members(reps[gi - 1]!);
      allLegs.push({
        ...legs.interCacheLegs[gi - 1]!,
        fromCacheId: prev[prev.length - 1]!,
        toCacheId: groupMembers[0]!,
      });
    }
    for (let mi = 0; mi < groupMembers.length; mi += 1) {
      orderedIds.push(groupMembers[mi]!);
      if (mi > 0)
        allLegs.push(zeroLeg(groupMembers[mi - 1]!, groupMembers[mi]!));
    }
  }
  const lastMembers = members(reps[reps.length - 1]!);
  allLegs.push({
    ...legs.lastToParking,
    fromCacheId: lastMembers[lastMembers.length - 1]!,
  });

  return { orderedIds, allLegs };
}
