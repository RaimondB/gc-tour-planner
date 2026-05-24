// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver;

import java.util.List;

import org.junit.jupiter.api.Test;

import ai.timefold.solver.test.api.score.stream.ConstraintVerifier;

import com.gctp.solver.domain.Cache;
import com.gctp.solver.domain.Tour;
import com.gctp.solver.domain.TourSolution;
import com.gctp.solver.solver.TourConstraintProvider;

/**
 * One assertion per MVP constraint. The ConstraintVerifier exercises each
 * rule in isolation against a hand-built {@link Tour} so a regression in
 * one rule cannot be masked by another.
 *
 * Method references are class-bound (e.g. {@code TourConstraintProvider::distanceBudget}),
 * which Java resolves to the {@code BiFunction<TourConstraintProvider, ConstraintFactory, Constraint>}
 * shape that {@code verifyThat} expects.
 */
class TourConstraintProviderTest {

    private final ConstraintVerifier<TourConstraintProvider, TourSolution> verifier =
            ConstraintVerifier.build(new TourConstraintProvider(), TourSolution.class, Tour.class, Cache.class);

    /** Build a Tour and the two cache problem facts that constraint streams need to see. */
    private record Fixture(Tour tour, Cache a, Cache b) { }

    private static Fixture tinyTour() {
        Cache a = new Cache(1L, 0, 0.0, 0.0);
        Cache b = new Cache(2L, 1, 0.01, 0.0);
        Tour t = new Tour();
        t.setVisitOrder(List.of(a, b));
        t.setMatrixMeters(new Double[][] {
            new Double[] { 0.0, 500.0 },
            new Double[] { 500.0, 0.0 }
        });
        t.setMatrixSeconds(new Double[][] {
            new Double[] { 0.0, 600.0 },
            new Double[] { 600.0, 0.0 }
        });
        t.setParkingToCacheMeters(new double[] { 100.0, 200.0 });
        t.setParkingToCacheSeconds(new double[] { 120.0, 240.0 });
        t.setCacheToParkingMeters(new double[] { 100.0, 200.0 });
        t.setCacheToParkingSeconds(new double[] { 120.0, 240.0 });
        t.setDistanceBudgetMeters(10_000L);
        t.setTimeBudgetSeconds(-1L);
        t.setVisitSecondsPerCache(300L);
        return new Fixture(t, a, b);
    }

    @Test
    void distanceBudgetPenalisesOverBudget() {
        Fixture f = tinyTour();
        // Total = 100 + 500 + 200 = 800 ≤ 10 000 ⇒ no penalty.
        verifier.verifyThat(TourConstraintProvider::distanceBudget)
                .given(f.tour(), f.a(), f.b())
                .penalizesBy(0L);

        Fixture over = tinyTour();
        over.tour().setDistanceBudgetMeters(500L);
        verifier.verifyThat(TourConstraintProvider::distanceBudget)
                .given(over.tour(), over.a(), over.b())
                .penalizesByMoreThan(0L);
    }

    @Test
    void timeBudgetOnlyAppliesWhenSupplied() {
        Fixture f = tinyTour(); // timeBudgetSeconds=-1 means "no budget"
        verifier.verifyThat(TourConstraintProvider::timeBudget)
                .given(f.tour(), f.a(), f.b())
                .penalizesBy(0L);

        Fixture tight = tinyTour();
        tight.tour().setTimeBudgetSeconds(100L);
        verifier.verifyThat(TourConstraintProvider::timeBudget)
                .given(tight.tour(), tight.a(), tight.b())
                .penalizesByMoreThan(0L);
    }

    @Test
    void reachableLegsPenalisesNullMatrixCells() {
        Fixture f = tinyTour();
        verifier.verifyThat(TourConstraintProvider::reachableLegs)
                .given(f.tour(), f.a(), f.b())
                .penalizesBy(0L);

        Fixture broken = tinyTour();
        broken.tour().setMatrixMeters(new Double[][] {
            new Double[] { 0.0, null },
            new Double[] { null, 0.0 }
        });
        verifier.verifyThat(TourConstraintProvider::reachableLegs)
                .given(broken.tour(), broken.a(), broken.b())
                .penalizesByMoreThan(0L);
    }

    @Test
    void visitedCountRewardsMoreVisits() {
        Fixture f = tinyTour();
        verifier.verifyThat(TourConstraintProvider::visitedCount)
                .given(f.tour(), f.a(), f.b())
                .rewardsWith(2L * f.tour().getVisitedCountWeight());
    }
}
