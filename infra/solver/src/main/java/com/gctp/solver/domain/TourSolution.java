// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver.domain;

import java.util.ArrayList;
import java.util.List;

import ai.timefold.solver.core.api.domain.solution.PlanningEntityProperty;
import ai.timefold.solver.core.api.domain.solution.PlanningScore;
import ai.timefold.solver.core.api.domain.solution.PlanningSolution;
import ai.timefold.solver.core.api.domain.solution.ProblemFactCollectionProperty;
import ai.timefold.solver.core.api.domain.valuerange.ValueRangeProvider;
import ai.timefold.solver.core.api.score.buildin.hardsoftlong.HardSoftLongScore;

/**
 * Planning solution: owns the candidate cache value range and a single
 * {@link Tour} entity that holds the list variable + matrix data.
 *
 * Timefold 1.x requires solution and entity to be distinct classes — the
 * solution must declare a {@link PlanningEntityProperty} (or its collection
 * variant) pointing at the entity. Keeping the entity single-instance makes
 * "pick a subset and order them" a clean list-variable problem.
 */
@PlanningSolution
public class TourSolution {

    @ProblemFactCollectionProperty
    @ValueRangeProvider
    private List<Cache> candidateCaches = new ArrayList<>();

    @PlanningEntityProperty
    private Tour tour;

    @PlanningScore
    private HardSoftLongScore score;

    public TourSolution() {
    }

    public TourSolution(List<Cache> candidateCaches, Tour tour) {
        this.candidateCaches = candidateCaches;
        this.tour = tour;
    }

    public List<Cache> getCandidateCaches() {
        return candidateCaches;
    }

    public void setCandidateCaches(List<Cache> candidateCaches) {
        this.candidateCaches = candidateCaches;
    }

    public Tour getTour() {
        return tour;
    }

    public void setTour(Tour tour) {
        this.tour = tour;
    }

    public HardSoftLongScore getScore() {
        return score;
    }

    public void setScore(HardSoftLongScore score) {
        this.score = score;
    }
}
