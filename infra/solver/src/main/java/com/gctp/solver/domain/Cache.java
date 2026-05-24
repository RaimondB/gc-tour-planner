// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package com.gctp.solver.domain;

import ai.timefold.solver.core.api.domain.lookup.PlanningId;

/**
 * A geocache that may or may not be visited in the tour. The planning entity is
 * the {@link Tour} itself (list-variable pattern), so Cache is a problem fact —
 * its identity and coordinates do not change during solving.
 *
 * The matrix index is the row/column position in the OD matrix passed in by
 * Nest. Constraints look up distance/time via the matrix using these indices.
 */
public class Cache {

    @PlanningId
    private long id;

    private int matrixIndex;
    private double lng;
    private double lat;

    public Cache() {
    }

    public Cache(long id, int matrixIndex, double lng, double lat) {
        this.id = id;
        this.matrixIndex = matrixIndex;
        this.lng = lng;
        this.lat = lat;
    }

    public long getId() {
        return id;
    }

    public void setId(long id) {
        this.id = id;
    }

    public int getMatrixIndex() {
        return matrixIndex;
    }

    public void setMatrixIndex(int matrixIndex) {
        this.matrixIndex = matrixIndex;
    }

    public double getLng() {
        return lng;
    }

    public void setLng(double lng) {
        this.lng = lng;
    }

    public double getLat() {
        return lat;
    }

    public void setLat(double lat) {
        this.lat = lat;
    }

    @Override
    public String toString() {
        return "Cache#" + id;
    }
}
