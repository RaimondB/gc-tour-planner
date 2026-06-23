// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver.service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;

import org.springframework.stereotype.Service;

import ai.timefold.solver.core.api.solver.SolverManager;
import ai.timefold.solver.core.api.solver.SolverJob;

import com.gctp.solver.domain.Cache;
import com.gctp.solver.domain.Tour;
import com.gctp.solver.domain.TourSolution;
import com.gctp.solver.rest.PlanRequest;
import com.gctp.solver.rest.PlanResponse;

/**
 * Bridges the wire DTO and the Timefold {@link SolverManager}.
 *
 * Constructs the {@link TourSolution} problem instance from the request, runs
 * the solver to completion (termination is configured in application.properties),
 * then collapses the best solution into a {@link PlanResponse}.
 */
@Service
public class PlanService {

    private final SolverManager<TourSolution, UUID> solverManager;

    public PlanService(SolverManager<TourSolution, UUID> solverManager) {
        this.solverManager = solverManager;
    }

    public PlanResponse plan(PlanRequest req) throws InterruptedException, ExecutionException {
        TourSolution problem = toProblem(req);

        // Seed the planning list with all candidate caches. Timefold's list
        // variable allows the solver to remove caches when their presence
        // creates a hard violation, so the seed is just a starting layout.
        problem.getTour().setVisitOrder(new ArrayList<>(problem.getCandidateCaches()));

        SolverJob<TourSolution, UUID> job = solverManager.solveBuilder()
                .withProblemId(UUID.randomUUID())
                .withProblem(problem)
                .run();
        TourSolution solved = job.getFinalBestSolution();

        return toResponse(solved.getTour());
    }

    private TourSolution toProblem(PlanRequest req) {
        List<Cache> caches = new ArrayList<>(req.caches().size());
        Map<String, Long> adventureCandidateCounts = new HashMap<>();
        for (int i = 0; i < req.caches().size(); i++) {
            PlanRequest.CacheInput c = req.caches().get(i);
            Cache cache = new Cache(c.id(), i, c.lng(), c.lat());
            cache.setAdventureId(c.adventureId());
            cache.setStageSequence(c.stageSequence());
            cache.setAdventureSequential(Boolean.TRUE.equals(c.adventureSequential()));
            caches.add(cache);
            if (c.adventureId() != null) {
                adventureCandidateCounts.merge(c.adventureId(), 1L, Long::sum);
            }
        }
        Tour tour = new Tour();
        tour.setMatrixMeters(req.matrixMeters());
        tour.setMatrixSeconds(req.matrixSeconds());
        tour.setParkingToCacheMeters(req.parkingToCacheMeters());
        tour.setParkingToCacheSeconds(req.parkingToCacheSeconds());
        tour.setCacheToParkingMeters(req.cacheToParkingMeters());
        tour.setCacheToParkingSeconds(req.cacheToParkingSeconds());
        tour.setDistanceBudgetMeters(req.distanceBudgetMeters());
        tour.setTimeBudgetSeconds(req.timeBudgetSeconds() == null ? -1L : req.timeBudgetSeconds());
        tour.setVisitSecondsPerCache(req.visitSecondsPerCache());
        tour.setAdventureCandidateCounts(adventureCandidateCounts);
        // Toggles default ON when the request omits them (older clients).
        tour.setCompleteAdventuresOnly(req.completeAdventuresOnly() == null || req.completeAdventuresOnly());
        tour.setAdventureInterleave(req.adventureInterleave() == null || req.adventureInterleave());
        if (req.weights() != null) {
            if (req.weights().visitedCount() != null) {
                tour.setVisitedCountWeight(req.weights().visitedCount());
            }
            if (req.weights().loopLength() != null) {
                tour.setLoopLengthWeight(req.weights().loopLength());
            }
        }
        return new TourSolution(caches, tour);
    }

    private PlanResponse toResponse(Tour solved) {
        List<Long> orderedIds = new ArrayList<>(solved.getVisitOrder().size());
        for (Cache c : solved.getVisitOrder()) {
            orderedIds.add(c.getId());
        }
        double meters = solved.totalMeters();
        double seconds = solved.totalSeconds();
        // Infinity (unreachable) collapses to 0 in the response; the corresponding
        // hard-broken solution would also have an empty / different visit list.
        if (Double.isInfinite(meters)) meters = 0.0;
        if (Double.isInfinite(seconds)) seconds = 0.0;
        return new PlanResponse(orderedIds, meters, seconds, orderedIds.size());
    }
}
