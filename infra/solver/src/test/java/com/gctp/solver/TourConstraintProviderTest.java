// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver;

import java.util.List;
import java.util.Map;

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

    // Cache is a problem FACT (no @PlanningEntity), so only Tour is registered
    // as the planning entity here; Cache instances are still passed to .given().
    private final ConstraintVerifier<TourConstraintProvider, TourSolution> verifier =
            ConstraintVerifier.build(new TourConstraintProvider(), TourSolution.class, Tour.class);

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

    @Test
    void loopLengthPenalisesLongerLoops() {
        Fixture f = tinyTour(); // total = 100 + 500 + 200 = 800 m, weight 1
        verifier.verifyThat(TourConstraintProvider::loopLength)
                .given(f.tour(), f.a(), f.b())
                .penalizesBy(800L);
    }

    /** Three caches; a + c belong to adventure "A" (2 candidate stages), b is plain. */
    private static Tour adventureTour(List<Cache> order) {
        Tour t = new Tour();
        t.setVisitOrder(order);
        t.setMatrixMeters(new Double[][] {
            new Double[] { 0.0, 500.0, 500.0 },
            new Double[] { 500.0, 0.0, 500.0 },
            new Double[] { 500.0, 500.0, 0.0 }
        });
        t.setMatrixSeconds(new Double[][] {
            new Double[] { 0.0, 600.0, 600.0 },
            new Double[] { 600.0, 0.0, 600.0 },
            new Double[] { 600.0, 600.0, 0.0 }
        });
        t.setParkingToCacheMeters(new double[] { 100.0, 100.0, 100.0 });
        t.setParkingToCacheSeconds(new double[] { 120.0, 120.0, 120.0 });
        t.setCacheToParkingMeters(new double[] { 100.0, 100.0, 100.0 });
        t.setCacheToParkingSeconds(new double[] { 120.0, 120.0, 120.0 });
        t.setDistanceBudgetMeters(100_000L);
        t.setTimeBudgetSeconds(-1L);
        t.setVisitSecondsPerCache(300L);
        t.setAdventureCandidateCounts(Map.of("A", 2L));
        return t;
    }

    private static Cache advCache(long id, int idx) {
        Cache c = new Cache(id, idx, 0.01 * idx, 0.0);
        c.setAdventureId("A");
        return c;
    }

    @Test
    void adventureAtomicityPenalisesPartialInclusion() {
        Cache a = advCache(1L, 0);
        Cache c = advCache(3L, 2);

        // Only stage a of the 2-stage adventure is in the order ⇒ partial ⇒ penalty.
        Tour partial = adventureTour(List.of(a));
        verifier.verifyThat(TourConstraintProvider::adventureAtomicity)
                .given(partial, a, c)
                .penalizesByMoreThan(0L);

        // Both stages present ⇒ whole adventure ⇒ no penalty.
        Tour whole = adventureTour(List.of(a, c));
        verifier.verifyThat(TourConstraintProvider::adventureAtomicity)
                .given(whole, a, c)
                .penalizesBy(0L);

        // Toggle off ⇒ never penalises even when partial.
        Tour off = adventureTour(List.of(a));
        off.setCompleteAdventuresOnly(false);
        verifier.verifyThat(TourConstraintProvider::adventureAtomicity)
                .given(off, a, c)
                .penalizesBy(0L);
    }

    @Test
    void adventureContiguityPenalisesGapsWhenNotInterleaving() {
        Cache a = advCache(1L, 0);
        Cache c = advCache(3L, 2);
        Cache b = new Cache(2L, 1, 0.01, 0.0); // plain, no adventure

        // a … b … c — the adventure's two stages straddle a foreign cache.
        Tour gapped = adventureTour(List.of(a, b, c));
        gapped.setAdventureInterleave(false);
        verifier.verifyThat(TourConstraintProvider::adventureContiguity)
                .given(gapped, a, b, c)
                .penalizesByMoreThan(0L);

        // a, c adjacent — contiguous block, no penalty.
        Tour contiguous = adventureTour(List.of(a, c, b));
        contiguous.setAdventureInterleave(false);
        verifier.verifyThat(TourConstraintProvider::adventureContiguity)
                .given(contiguous, a, b, c)
                .penalizesBy(0L);

        // Interleave allowed ⇒ no penalty even with a gap.
        Tour interleaved = adventureTour(List.of(a, b, c));
        interleaved.setAdventureInterleave(true);
        verifier.verifyThat(TourConstraintProvider::adventureContiguity)
                .given(interleaved, a, b, c)
                .penalizesBy(0L);
    }
}
