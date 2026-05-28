// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Single source of truth for "this zoom is when parking starts to show".
 * Both CachesLayer's cache-owner parking pins and OsmParkingLayer's
 * point circles + fetch gate use this so the two layers can never get
 * out of sync — when one appears, both appear. OsmParkingLayer still
 * scales internally above this (polygons one zoom above, labels two
 * above), but that's intra-layer detail, not layer-vs-layer mismatch.
 */
export const PARKING_MIN_ZOOM = 12;
