// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver.solver;

import ai.timefold.solver.core.api.score.buildin.hardmediumsoftlong.HardMediumSoftLongScore;
import ai.timefold.solver.core.api.score.stream.Constraint;
import ai.timefold.solver.core.api.score.stream.ConstraintFactory;
import ai.timefold.solver.core.api.score.stream.ConstraintProvider;

import com.gctp.solver.domain.Tour;

/**
 * Constraint set per ADR-0005 / SolverTourPlanner brief:
 *   - HARD:   distance budget respected
 *   - HARD:   time budget respected (only when supplied)
 *   - HARD:   every leg in the order is reachable (no null matrix cells)
 *   - HARD:   Adventure Lab atomicity — an adventure is included whole or not
 *             at all (only when {@code completeAdventuresOnly})
 *   - HARD:   Adventure Lab contiguity — an adventure's stages stay consecutive
 *             (only when {@code !adventureInterleave})
 *   - HARD:   Adventure Lab ordering — a *linear* adventure's stages appear in
 *             ascending stageSequence order (foreign caches may interleave);
 *             data-driven per cache, orthogonal to contiguity
 *   - MEDIUM: reward count of visited caches × {@code visitedCountWeight}
 *   - SOFT:   penalise total closed-loop metres × {@code loopLengthWeight}
 *
 * The three-level score makes selection strictly lexicographic: count (MEDIUM)
 * dominates loop length (SOFT), so the solver never drops a cache to shorten the
 * loop — it only compacts the loop among equal-count solutions. That's the
 * loop-shape objective the greedy planner lacks.
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
            adventureAtomicity(factory),
            adventureContiguity(factory),
            adventureOrdering(factory),
            visitedCount(factory),
            loopLength(factory)
        };
    }

    public Constraint distanceBudget(ConstraintFactory factory) {
        return factory.forEach(Tour.class)
                .filter(tour -> tour.totalMeters() > tour.getDistanceBudgetMeters())
                .penalizeLong(
                        HardMediumSoftLongScore.ONE_HARD,
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
                        HardMediumSoftLongScore.ONE_HARD,
                        tour -> Math.max(
                                1L,
                                (long) Math.ceil(tour.totalSeconds() - tour.getTimeBudgetSeconds())))
                .asConstraint("time budget");
    }

    public Constraint reachableLegs(ConstraintFactory factory) {
        return factory.forEach(Tour.class)
                .filter(Tour::hasUnreachableLeg)
                .penalizeLong(HardMediumSoftLongScore.ONE_HARD, tour -> 1_000L)
                .asConstraint("reachable legs");
    }

    public Constraint adventureAtomicity(ConstraintFactory factory) {
        return factory.forEach(Tour.class)
                .filter(tour -> tour.isCompleteAdventuresOnly()
                        && tour.partialAdventurePenalty() > 0L)
                .penalizeLong(HardMediumSoftLongScore.ONE_HARD, Tour::partialAdventurePenalty)
                .asConstraint("adventure atomicity");
    }

    public Constraint adventureContiguity(ConstraintFactory factory) {
        return factory.forEach(Tour.class)
                .filter(tour -> !tour.isAdventureInterleave()
                        && tour.contiguityGapPenalty() > 0L)
                .penalizeLong(HardMediumSoftLongScore.ONE_HARD, Tour::contiguityGapPenalty)
                .asConstraint("adventure contiguity");
    }

    public Constraint adventureOrdering(ConstraintFactory factory) {
        return factory.forEach(Tour.class)
                .filter(tour -> tour.orderingViolationPenalty() > 0L)
                .penalizeLong(HardMediumSoftLongScore.ONE_HARD, Tour::orderingViolationPenalty)
                .asConstraint("adventure ordering");
    }

    public Constraint visitedCount(ConstraintFactory factory) {
        return factory.forEach(Tour.class)
                .rewardLong(
                        HardMediumSoftLongScore.ONE_MEDIUM,
                        tour -> (long) tour.getVisitOrder().size() * tour.getVisitedCountWeight())
                .asConstraint("visited count");
    }

    public Constraint loopLength(ConstraintFactory factory) {
        return factory.forEach(Tour.class)
                .filter(tour -> !tour.getVisitOrder().isEmpty()
                        && Double.isFinite(tour.totalMeters()))
                .penalizeLong(
                        HardMediumSoftLongScore.ONE_SOFT,
                        tour -> Math.max(0L, (long) Math.ceil(tour.totalMeters() * tour.getLoopLengthWeight())))
                .asConstraint("loop length");
    }
}
