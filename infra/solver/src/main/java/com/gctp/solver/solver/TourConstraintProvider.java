// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver.solver;

import ai.timefold.solver.core.api.score.buildin.hardsoftlong.HardSoftLongScore;
import ai.timefold.solver.core.api.score.stream.Constraint;
import ai.timefold.solver.core.api.score.stream.ConstraintFactory;
import ai.timefold.solver.core.api.score.stream.ConstraintProvider;

import com.gctp.solver.domain.Tour;

/**
 * MVP constraint set per ADR-0005 / SolverTourPlanner brief:
 *   - HARD:  distance budget respected
 *   - HARD:  time budget respected (only when supplied)
 *   - HARD:  every leg in the order is reachable (no null matrix cells)
 *   - SOFT:  reward count of visited caches × {@code visitedCountWeight}
 *
 * Terrain mix / landuse / pace-fit constraints are intentionally deferred —
 * they will land in a follow-up wave alongside the weights schema work.
 *
 * Because Tour is its own planning entity AND solution (list-variable on a
 * single instance), each constraint is a {@code forEach(Tour.class)} stream
 * that fires exactly once per solution and uses the helper methods on Tour
 * for the actual arithmetic. This keeps the constraints declarative even
 * though the underlying check is "compute totals, compare to budget".
 */
public class TourConstraintProvider implements ConstraintProvider {

    @Override
    public Constraint[] defineConstraints(ConstraintFactory factory) {
        return new Constraint[] {
            distanceBudget(factory),
            timeBudget(factory),
            reachableLegs(factory),
            visitedCount(factory)
        };
    }

    public Constraint distanceBudget(ConstraintFactory factory) {
        return factory.forEach(Tour.class)
                .filter(tour -> tour.totalMeters() > tour.getDistanceBudgetMeters())
                .penalizeLong(
                        HardSoftLongScore.ONE_HARD,
                        tour -> Math.max(
                                1L,
                                (long) Math.ceil(tour.totalMeters() - tour.getDistanceBudgetMeters())))
                .asConstraint("distance budget");
    }

    public Constraint timeBudget(ConstraintFactory factory) {
        return factory.forEach(Tour.class)
                .filter(tour -> tour.getTimeBudgetSeconds() > 0
                        && tour.totalSeconds() > tour.getTimeBudgetSeconds())
                .penalizeLong(
                        HardSoftLongScore.ONE_HARD,
                        tour -> Math.max(
                                1L,
                                (long) Math.ceil(tour.totalSeconds() - tour.getTimeBudgetSeconds())))
                .asConstraint("time budget");
    }

    public Constraint reachableLegs(ConstraintFactory factory) {
        return factory.forEach(Tour.class)
                .filter(Tour::hasUnreachableLeg)
                .penalizeLong(HardSoftLongScore.ONE_HARD, tour -> 1_000L)
                .asConstraint("reachable legs");
    }

    public Constraint visitedCount(ConstraintFactory factory) {
        return factory.forEach(Tour.class)
                .rewardLong(
                        HardSoftLongScore.ONE_SOFT,
                        tour -> (long) tour.getVisitOrder().size() * tour.getVisitedCountWeight())
                .asConstraint("visited count");
    }
}
