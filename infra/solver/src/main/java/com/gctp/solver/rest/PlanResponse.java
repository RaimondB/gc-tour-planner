// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver.rest;

import java.util.List;

/**
 * Solver output. Nest does the OSRM geometry stitching, parking choice
 * packaging, and score-breakdown construction.
 */
public record PlanResponse(
        List<Long> orderedCacheIds,
        double totalMeters,
        double totalSeconds,
        int visitedCount
) {}
