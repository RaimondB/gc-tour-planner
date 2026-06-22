// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver.domain;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

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

    /**
     * Soft penalty per metre of the closed loop. Kept on the SOFT level while
     * the visited-count reward lives on MEDIUM, so the solver never sacrifices a
     * cache to shorten the loop — it only compacts among equal-count solutions.
     */
    private long loopLengthWeight = 1L;

    /** Adventure atomicity: include an adventure whole or not at all (FR-I16). */
    private boolean completeAdventuresOnly = true;
    /** When false, an adventure's stages must be consecutive in the visit order. */
    private boolean adventureInterleave = true;

    /**
     * adventureId → number of candidate caches that belong to it. Lets the
     * atomicity constraint tell "all of this adventure is in the order" from
     * "only some of it is" without re-deriving the candidate set.
     */
    private Map<String, Long> adventureCandidateCounts = new HashMap<>();

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

    public long getLoopLengthWeight() {
        return loopLengthWeight;
    }

    public void setLoopLengthWeight(long loopLengthWeight) {
        this.loopLengthWeight = loopLengthWeight;
    }

    public boolean isCompleteAdventuresOnly() {
        return completeAdventuresOnly;
    }

    public void setCompleteAdventuresOnly(boolean completeAdventuresOnly) {
        this.completeAdventuresOnly = completeAdventuresOnly;
    }

    public boolean isAdventureInterleave() {
        return adventureInterleave;
    }

    public void setAdventureInterleave(boolean adventureInterleave) {
        this.adventureInterleave = adventureInterleave;
    }

    public Map<String, Long> getAdventureCandidateCounts() {
        return adventureCandidateCounts;
    }

    public void setAdventureCandidateCounts(Map<String, Long> adventureCandidateCounts) {
        this.adventureCandidateCounts = adventureCandidateCounts;
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

    /**
     * Atomicity penalty: the number of candidate stages missing from any
     * adventure that is *partially* present in the visit order. Zero when every
     * touched adventure is included whole (or absent). The constraint gates this
     * on {@link #completeAdventuresOnly}.
     */
    public long partialAdventurePenalty() {
        Map<String, Long> included = new HashMap<>();
        for (Cache c : visitOrder) {
            String aid = c.getAdventureId();
            if (aid != null) {
                included.merge(aid, 1L, Long::sum);
            }
        }
        long penalty = 0L;
        for (Map.Entry<String, Long> e : included.entrySet()) {
            long total = adventureCandidateCounts.getOrDefault(e.getKey(), e.getValue());
            if (e.getValue() < total) {
                penalty += total - e.getValue();
            }
        }
        return penalty;
    }

    /**
     * Contiguity penalty: for each adventure with stages in the order, the count
     * of foreign caches that interleave between its first and last stage (i.e.
     * {@code span - stageCount}). Zero when every adventure forms one
     * uninterrupted block. The constraint gates this on
     * {@code !adventureInterleave}.
     */
    public long contiguityGapPenalty() {
        Map<String, Integer> minPos = new HashMap<>();
        Map<String, Integer> maxPos = new HashMap<>();
        Map<String, Long> count = new HashMap<>();
        for (int i = 0; i < visitOrder.size(); i++) {
            String aid = visitOrder.get(i).getAdventureId();
            if (aid == null) {
                continue;
            }
            final int pos = i;
            minPos.merge(aid, pos, Math::min);
            maxPos.merge(aid, pos, Math::max);
            count.merge(aid, 1L, Long::sum);
        }
        long penalty = 0L;
        for (Map.Entry<String, Long> e : count.entrySet()) {
            long span = (long) maxPos.get(e.getKey()) - minPos.get(e.getKey()) + 1L;
            if (span > e.getValue()) {
                penalty += span - e.getValue();
            }
        }
        return penalty;
    }

    /**
     * Ordering penalty for *linear* adventures: walking the visit order, the
     * number of times a sequential AL stage appears after a same-adventure stage
     * with a higher {@code stageSequence} (an inversion). Zero when every linear
     * adventure's stages are in ascending sequence order — foreign caches may
     * still interleave between them. Data-driven per cache
     * ({@link Cache#isAdventureSequential()}); no tour-level flag.
     */
    public long orderingViolationPenalty() {
        Map<String, Integer> lastSeq = new HashMap<>();
        long penalty = 0L;
        for (Cache c : visitOrder) {
            if (!c.isAdventureSequential() || c.getStageSequence() == null) {
                continue;
            }
            String aid = c.getAdventureId();
            if (aid == null) {
                continue;
            }
            Integer prev = lastSeq.get(aid);
            int seq = c.getStageSequence();
            if (prev != null && seq < prev) {
                penalty++;
            }
            lastSeq.put(aid, seq);
        }
        return penalty;
    }
}
