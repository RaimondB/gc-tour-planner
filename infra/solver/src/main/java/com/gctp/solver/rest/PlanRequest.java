// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver.rest;

import java.util.List;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Wire DTO for {@code POST /plan}. Cells in matrixMeters / matrixSeconds may be
 * {@code null} to mark an unreachable pair (OSRM "NoRoute"); the solver treats
 * any such adjacency as a hard violation.
 *
 * @param caches               size N — id + coordinates. matrixIndex = position
 * @param matrixMeters         N×N inter-cache walking distance
 * @param matrixSeconds        N×N inter-cache walking duration
 * @param parkingToCacheMeters length N — from parking to caches[i]
 * @param parkingToCacheSeconds length N — from parking to caches[i]
 * @param cacheToParkingMeters length N — from caches[i] back to parking (closing leg)
 * @param cacheToParkingSeconds length N — from caches[i] back to parking
 * @param distanceBudgetMeters hard cap on total tour distance
 * @param timeBudgetSeconds    hard cap on total tour time, or null
 * @param visitSecondsPerCache per-cache visit time added to total time
 * @param completeAdventuresOnly enforce Adventure Lab atomicity (whole or none)
 * @param adventureInterleave  when false, an adventure's stages must be contiguous
 * @param weights              score weights (visitedCount = MEDIUM, loopLength = SOFT)
 */
public record PlanRequest(
        List<CacheInput> caches,
        @JsonProperty("matrixMeters") Double[][] matrixMeters,
        @JsonProperty("matrixSeconds") Double[][] matrixSeconds,
        @JsonProperty("parkingToCacheMeters") double[] parkingToCacheMeters,
        @JsonProperty("parkingToCacheSeconds") double[] parkingToCacheSeconds,
        @JsonProperty("cacheToParkingMeters") double[] cacheToParkingMeters,
        @JsonProperty("cacheToParkingSeconds") double[] cacheToParkingSeconds,
        @JsonProperty("distanceBudgetMeters") long distanceBudgetMeters,
        @JsonProperty("timeBudgetSeconds") Long timeBudgetSeconds,
        @JsonProperty("visitSecondsPerCache") long visitSecondsPerCache,
        @JsonProperty("completeAdventuresOnly") Boolean completeAdventuresOnly,
        @JsonProperty("adventureInterleave") Boolean adventureInterleave,
        Weights weights
) {
    /**
     * {@code adventureId} is null for a plain cache; non-null groups Adventure
     * Lab stages. {@code adventureSequential} is true for a *linear* adventure's
     * stages (must be visited in {@code stageSequence} order).
     */
    public record CacheInput(
            long id,
            double lng,
            double lat,
            @JsonProperty("adventureId") String adventureId,
            @JsonProperty("stageSequence") Integer stageSequence,
            @JsonProperty("adventureSequential") Boolean adventureSequential) {}

    public record Weights(
            @JsonProperty("visitedCount") Long visitedCount,
            @JsonProperty("loopLength") Long loopLength) {}
}
