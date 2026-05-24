// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver.domain;

import java.util.ArrayList;
import java.util.List;

import ai.timefold.solver.core.api.domain.entity.PlanningEntity;
import ai.timefold.solver.core.api.domain.variable.PlanningListVariable;

/**
 * Planning entity. Owns the ordered list of visited caches plus the per-solve
 * matrix data and budget caps (carried as plain fields, not planning data, so
 * constraint streams can read them without joining problem facts).
 *
 * Caches absent from {@link #visitOrder} are simply skipped — Timefold's list
 * variable allows the solver to leave items out when including them would
 * break a hard constraint. The seed in {@code PlanService} starts with every
 * cache assigned; the solver may drop them to satisfy the budgets.
 */
@PlanningEntity
public class Tour {

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

    public Tour() {
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
