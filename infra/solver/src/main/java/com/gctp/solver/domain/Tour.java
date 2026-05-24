// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver.domain;

import java.util.ArrayList;
import java.util.List;

import ai.timefold.solver.core.api.domain.entity.PlanningEntity;
import ai.timefold.solver.core.api.domain.solution.PlanningEntityCollectionProperty;
import ai.timefold.solver.core.api.domain.solution.PlanningScore;
import ai.timefold.solver.core.api.domain.solution.PlanningSolution;
import ai.timefold.solver.core.api.domain.solution.ProblemFactCollectionProperty;
import ai.timefold.solver.core.api.domain.valuerange.ValueRangeProvider;
import ai.timefold.solver.core.api.domain.variable.PlanningListVariable;
import ai.timefold.solver.core.api.score.buildin.hardsoft.HardSoftScore;

/**
 * Planning solution AND planning entity (single-entity list-variable pattern).
 *
 * The Tour owns the ordered list of visited caches. Caches absent from
 * {@code visitOrder} are simply skipped — the solver may choose to leave caches
 * out when their inclusion would violate a hard constraint.
 *
 * The full {@code candidateCaches} list is the value range for
 * {@link #visitOrder}; Timefold uses it to source insertion candidates.
 *
 * Distance / time / budget data live on the Tour as problem facts so
 * constraint streams can index into the matrix without round-tripping through
 * Spring beans.
 */
@PlanningEntity
@PlanningSolution
public class Tour {

    @ProblemFactCollectionProperty
    @ValueRangeProvider
    private List<Cache> candidateCaches = new ArrayList<>();

    @PlanningListVariable
    private List<Cache> visitOrder = new ArrayList<>();

    /** Square matrix [i][j] = meters from candidateCaches[i] to candidateCaches[j]; null = unreachable. */
    private Double[][] matrixMeters;
    /** Same layout as matrixMeters, in seconds. */
    private Double[][] matrixSeconds;

    /** Per-cache (by matrixIndex) leg from parking → cache, meters. */
    private double[] parkingToCacheMeters;
    private double[] parkingToCacheSeconds;
    /** Per-cache (by matrixIndex) leg from cache → parking, meters. */
    private double[] cacheToParkingMeters;
    private double[] cacheToParkingSeconds;

    private long distanceBudgetMeters;
    /** -1 means "no time budget". */
    private long timeBudgetSeconds = -1L;
    private long visitSecondsPerCache;

    private long visitedCountWeight = 100L;

    @PlanningScore
    private HardSoftScore score;

    public Tour() {
    }

    public List<Cache> getCandidateCaches() {
        return candidateCaches;
    }

    public void setCandidateCaches(List<Cache> candidateCaches) {
        this.candidateCaches = candidateCaches;
    }

    public List<Cache> getVisitOrder() {
        return visitOrder;
    }

    public void setVisitOrder(List<Cache> visitOrder) {
        this.visitOrder = visitOrder;
    }

    public Double[][] getMatrixMeters() {
        return matrixMeters;
    }

    public void setMatrixMeters(Double[][] matrixMeters) {
        this.matrixMeters = matrixMeters;
    }

    public Double[][] getMatrixSeconds() {
        return matrixSeconds;
    }

    public void setMatrixSeconds(Double[][] matrixSeconds) {
        this.matrixSeconds = matrixSeconds;
    }

    public double[] getParkingToCacheMeters() {
        return parkingToCacheMeters;
    }

    public void setParkingToCacheMeters(double[] parkingToCacheMeters) {
        this.parkingToCacheMeters = parkingToCacheMeters;
    }

    public double[] getParkingToCacheSeconds() {
        return parkingToCacheSeconds;
    }

    public void setParkingToCacheSeconds(double[] parkingToCacheSeconds) {
        this.parkingToCacheSeconds = parkingToCacheSeconds;
    }

    public double[] getCacheToParkingMeters() {
        return cacheToParkingMeters;
    }

    public void setCacheToParkingMeters(double[] cacheToParkingMeters) {
        this.cacheToParkingMeters = cacheToParkingMeters;
    }

    public double[] getCacheToParkingSeconds() {
        return cacheToParkingSeconds;
    }

    public void setCacheToParkingSeconds(double[] cacheToParkingSeconds) {
        this.cacheToParkingSeconds = cacheToParkingSeconds;
    }

    public long getDistanceBudgetMeters() {
        return distanceBudgetMeters;
    }

    public void setDistanceBudgetMeters(long distanceBudgetMeters) {
        this.distanceBudgetMeters = distanceBudgetMeters;
    }

    public long getTimeBudgetSeconds() {
        return timeBudgetSeconds;
    }

    public void setTimeBudgetSeconds(long timeBudgetSeconds) {
        this.timeBudgetSeconds = timeBudgetSeconds;
    }

    public long getVisitSecondsPerCache() {
        return visitSecondsPerCache;
    }

    public void setVisitSecondsPerCache(long visitSecondsPerCache) {
        this.visitSecondsPerCache = visitSecondsPerCache;
    }

    public long getVisitedCountWeight() {
        return visitedCountWeight;
    }

    public void setVisitedCountWeight(long visitedCountWeight) {
        this.visitedCountWeight = visitedCountWeight;
    }

    public HardSoftScore getScore() {
        return score;
    }

    public void setScore(HardSoftScore score) {
        this.score = score;
    }

    // ─── Derived helpers used by constraints ──────────────────────────────

    /** Total leg meters (parking → first → … → last → parking) for the current order. */
    public double totalMeters() {
        if (visitOrder.isEmpty()) {
            return 0.0;
        }
        double total = parkingToCacheMeters[visitOrder.get(0).getMatrixIndex()];
        for (int i = 0; i < visitOrder.size() - 1; i++) {
            Double leg = matrixMeters[visitOrder.get(i).getMatrixIndex()]
                    [visitOrder.get(i + 1).getMatrixIndex()];
            if (leg == null) {
                return Double.POSITIVE_INFINITY;
            }
            total += leg;
        }
        total += cacheToParkingMeters[visitOrder.get(visitOrder.size() - 1).getMatrixIndex()];
        return total;
    }

    /** Total seconds: legs + per-cache visit time. */
    public double totalSeconds() {
        if (visitOrder.isEmpty()) {
            return 0.0;
        }
        double total = parkingToCacheSeconds[visitOrder.get(0).getMatrixIndex()];
        for (int i = 0; i < visitOrder.size() - 1; i++) {
            Double leg = matrixSeconds[visitOrder.get(i).getMatrixIndex()]
                    [visitOrder.get(i + 1).getMatrixIndex()];
            if (leg == null) {
                return Double.POSITIVE_INFINITY;
            }
            total += leg;
        }
        total += cacheToParkingSeconds[visitOrder.get(visitOrder.size() - 1).getMatrixIndex()];
        total += (double) visitSecondsPerCache * visitOrder.size();
        return total;
    }

    /** True if any adjacent pair (incl. parking legs) has a null/infinite distance. */
    public boolean hasUnreachableLeg() {
        if (visitOrder.isEmpty()) {
            return false;
        }
        for (int i = 0; i < visitOrder.size() - 1; i++) {
            Double leg = matrixMeters[visitOrder.get(i).getMatrixIndex()]
                    [visitOrder.get(i + 1).getMatrixIndex()];
            if (leg == null) {
                return true;
            }
        }
        return false;
    }
}
