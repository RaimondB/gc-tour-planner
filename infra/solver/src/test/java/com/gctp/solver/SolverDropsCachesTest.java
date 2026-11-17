// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

import ai.timefold.solver.core.api.solver.Solver;
import ai.timefold.solver.core.api.solver.SolverFactory;
import ai.timefold.solver.core.config.solver.EnvironmentMode;
import ai.timefold.solver.core.config.solver.SolverConfig;
import ai.timefold.solver.core.config.solver.termination.TerminationConfig;

import com.gctp.solver.domain.Cache;
import com.gctp.solver.domain.Tour;
import com.gctp.solver.domain.TourSolution;
import com.gctp.solver.solver.TourConstraintProvider;

/**
 * Runs a real solve, not a single constraint: the solver must be able to leave
 * caches out of the visit order when visiting all of them breaks a hard budget.
 * The per-constraint ConstraintVerifier tests can't catch a solver that is forced
 * to assign every cache — that only shows up end-to-end.
 */
class SolverDropsCachesTest {

    private static Solver<TourSolution> solver() {
        SolverConfig config = new SolverConfig()
                .withSolutionClass(TourSolution.class)
                .withEntityClasses(Tour.class)
                .withConstraintProviderClass(TourConstraintProvider.class)
                .withEnvironmentMode(EnvironmentMode.REPRODUCIBLE)
                .withTerminationConfig(new TerminationConfig()
                        .withUnimprovedSpentLimit(Duration.ofMillis(300))
                        .withSpentLimit(Duration.ofSeconds(3)));
        return SolverFactory.<TourSolution>create(config).buildSolver();
    }

    /** n caches, every leg (parking↔cache and cache↔cache) is 1 km / 12 min. */
    private static TourSolution problem(int n, long distanceBudget, long timeBudgetSeconds) {
        List<Cache> caches = new ArrayList<>();
        Double[][] meters = new Double[n][n];
        Double[][] seconds = new Double[n][n];
        double[] legM = new double[n];
        double[] legS = new double[n];
        for (int i = 0; i < n; i++) {
            caches.add(new Cache((long) i + 1, i, 0.01 * i, 0.0));
            legM[i] = 1000.0;
            legS[i] = 720.0;
            for (int j = 0; j < n; j++) {
                meters[i][j] = i == j ? 0.0 : 1000.0;
                seconds[i][j] = i == j ? 0.0 : 720.0;
            }
        }
        Tour tour = new Tour();
        tour.setMatrixMeters(meters);
        tour.setMatrixSeconds(seconds);
        tour.setParkingToCacheMeters(legM);
        tour.setParkingToCacheSeconds(legS);
        tour.setCacheToParkingMeters(legM.clone());
        tour.setCacheToParkingSeconds(legS.clone());
        tour.setDistanceBudgetMeters(distanceBudget);
        tour.setTimeBudgetSeconds(timeBudgetSeconds);
        tour.setVisitSecondsPerCache(300L);
        // Same seed as PlanService: every candidate starts assigned.
        tour.setVisitOrder(new ArrayList<>(caches));
        return new TourSolution(caches, tour);
    }

    @Test
    void dropsCachesToMeetTheDistanceBudget() {
        // 2 caches = 1 + 1 + 1 km = 3 km fits; a 3rd would need 4 km.
        TourSolution solved = solver().solve(problem(4, 3000L, -1L));

        assertThat(solved.getScore().isFeasible()).isTrue();
        assertThat(solved.getTour().getVisitOrder()).hasSize(2);
        assertThat(solved.getTour().totalMeters()).isLessThanOrEqualTo(3000.0);
    }

    @Test
    void dropsCachesToMeetTheTimeBudget() {
        // Generous distance, tight time: 1 cache = 2 legs × 12 min + 5 min = 29 min;
        // 2 caches = 3 × 12 + 10 = 46 min. A 40 min budget fits exactly one.
        TourSolution solved = solver().solve(problem(4, 100_000L, 40L * 60L));

        assertThat(solved.getScore().isFeasible()).isTrue();
        assertThat(solved.getTour().getVisitOrder()).hasSize(1);
    }

    @Test
    void keepsEveryCacheWhenTheBudgetAllows() {
        TourSolution solved = solver().solve(problem(4, 100_000L, -1L));

        assertThat(solved.getScore().isFeasible()).isTrue();
        assertThat(solved.getTour().getVisitOrder()).hasSize(4);
    }

    @Test
    void usesEachCachesOwnVisitTimeAgainstTheTimeBudget() {
        // 3 caches; cache 1 takes 60 min, the others 5. Visiting the two quick
        // ones = 3 legs × 12 min + 10 min = 46 min, which fits 50 min; any set
        // with the slow cache can't. Uniform 5 min would have allowed 2 of any.
        TourSolution problem = problem(3, 100_000L, 50L * 60L);
        problem.getCandidateCaches().get(0).setVisitSeconds(3600L);
        TourSolution solved = solver().solve(problem);

        assertThat(solved.getScore().isFeasible()).isTrue();
        assertThat(solved.getTour().getVisitOrder())
                .extracting(Cache::getId)
                .containsExactlyInAnyOrder(2L, 3L);
    }
}
