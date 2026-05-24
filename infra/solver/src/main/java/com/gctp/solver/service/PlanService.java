// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver.service;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutionException;

import org.springframework.stereotype.Service;

import ai.timefold.solver.core.api.solver.SolverManager;
import ai.timefold.solver.core.api.solver.SolverJob;

import com.gctp.solver.domain.Cache;
import com.gctp.solver.domain.Tour;
import com.gctp.solver.rest.PlanRequest;
import com.gctp.solver.rest.PlanResponse;

/**
 * Bridges the wire DTO and the Timefold {@link SolverManager}.
 *
 * Constructs the {@link Tour} problem instance from the request, runs the
 * solver to completion (termination is configured in application.properties),
 * then collapses the best solution into a {@link PlanResponse}.
 */
@Service
public class PlanService {

    private final SolverManager<Tour, UUID> solverManager;

    public PlanService(SolverManager<Tour, UUID> solverManager) {
        this.solverManager = solverManager;
    }

    public PlanResponse plan(PlanRequest req) throws InterruptedException, ExecutionException {
        Tour problem = toProblem(req);

        // Seed the planning list with all candidate caches. Timefold's list
        // variable allows the solver to remove caches when their presence
        // creates a hard violation, so the seed is just a starting layout.
        problem.setVisitOrder(new ArrayList<>(problem.getCandidateCaches()));

        SolverJob<Tour, UUID> job = solverManager.solveBuilder()
                .withProblemId(UUID.randomUUID())
                .withProblem(problem)
                .run();
        Tour solved = job.getFinalBestSolution();

        return toResponse(solved);
    }

    private Tour toProblem(PlanRequest req) {
        Tour t = new Tour();
        List<Cache> caches = new ArrayList<>(req.caches().size());
        for (int i = 0; i < req.caches().size(); i++) {
            PlanRequest.CacheInput c = req.caches().get(i);
            caches.add(new Cache(c.id(), i, c.lng(), c.lat()));
        }
        t.setCandidateCaches(caches);
        t.setMatrixMeters(req.matrixMeters());
        t.setMatrixSeconds(req.matrixSeconds());
        t.setParkingToCacheMeters(req.parkingToCacheMeters());
        t.setParkingToCacheSeconds(req.parkingToCacheSeconds());
        t.setCacheToParkingMeters(req.cacheToParkingMeters());
        t.setCacheToParkingSeconds(req.cacheToParkingSeconds());
        t.setDistanceBudgetMeters(req.distanceBudgetMeters());
        t.setTimeBudgetSeconds(req.timeBudgetSeconds() == null ? -1L : req.timeBudgetSeconds());
        t.setVisitSecondsPerCache(req.visitSecondsPerCache());
        if (req.weights() != null && req.weights().visitedCount() != null) {
            t.setVisitedCountWeight(req.weights().visitedCount());
        }
        return t;
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
