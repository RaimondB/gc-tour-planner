// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver;

import java.util.List;

import org.junit.jupiter.api.Test;

import ai.timefold.solver.test.api.score.stream.ConstraintVerifier;

import com.gctp.solver.domain.Cache;
import com.gctp.solver.domain.Tour;
import com.gctp.solver.solver.TourConstraintProvider;

/**
 * One assertion per MVP constraint. The ConstraintVerifier exercises each
 * rule in isolation against a hand-built {@link Tour} so a regression in
 * one rule cannot be masked by another.
 */
class TourConstraintProviderTest {

    private final ConstraintVerifier<TourConstraintProvider, Tour> verifier =
            ConstraintVerifier.build(new TourConstraintProvider(), Tour.class, Cache.class);

    private static Tour tinyTour() {
        Cache a = new Cache(1L, 0, 0.0, 0.0);
        Cache b = new Cache(2L, 1, 0.01, 0.0);
        Tour t = new Tour();
        t.setCandidateCaches(List.of(a, b));
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
        return t;
    }

    @Test
    void distanceBudgetPenalisesOverBudget() {
        Tour t = tinyTour();
        // Total = 100 + 500 + 200 = 800 ≤ 10 000 ⇒ no penalty.
        verifier.verifyThat(new TourConstraintProvider()::distanceBudget)
                .given(t.getCandidateCaches().toArray())
                .given(t)
                .penalizesBy(0L);

        Tour over = tinyTour();
        over.setDistanceBudgetMeters(500L);
        verifier.verifyThat(new TourConstraintProvider()::distanceBudget)
                .given(over.getCandidateCaches().toArray())
                .given(over)
                .penalizesByMoreThan(0L);
    }

    @Test
    void timeBudgetOnlyAppliesWhenSupplied() {
        Tour t = tinyTour(); // timeBudgetSeconds=-1 means "no budget"
        verifier.verifyThat(new TourConstraintProvider()::timeBudget)
                .given(t.getCandidateCaches().toArray())
                .given(t)
                .penalizesBy(0L);

        Tour tight = tinyTour();
        tight.setTimeBudgetSeconds(100L);
        verifier.verifyThat(new TourConstraintProvider()::timeBudget)
                .given(tight.getCandidateCaches().toArray())
                .given(tight)
                .penalizesByMoreThan(0L);
    }

    @Test
    void reachableLegsPenalisesNullMatrixCells() {
        Tour t = tinyTour();
        verifier.verifyThat(new TourConstraintProvider()::reachableLegs)
                .given(t.getCandidateCaches().toArray())
                .given(t)
                .penalizesBy(0L);

        Tour broken = tinyTour();
        broken.setMatrixMeters(new Double[][] {
            new Double[] { 0.0, null },
            new Double[] { null, 0.0 }
        });
        verifier.verifyThat(new TourConstraintProvider()::reachableLegs)
                .given(broken.getCandidateCaches().toArray())
                .given(broken)
                .penalizesByMoreThan(0L);
    }

    @Test
    void visitedCountRewardsMoreVisits() {
        Tour t = tinyTour();
        verifier.verifyThat(new TourConstraintProvider()::visitedCount)
                .given(t.getCandidateCaches().toArray())
                .given(t)
                .rewardsWith(2L * t.getVisitedCountWeight());
    }
}
