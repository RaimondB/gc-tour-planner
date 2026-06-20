// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Stable BullMQ queue names. The same string is the Bull-Board route key
 * and the Redis key prefix, so don't rename without a migration window.
 */
export const QUEUE_WALKING_PRECOMPUTE = "walking-precompute";
/** Bulk Adventure Lab area import (FR-I15) — admin-triggered, runs off-request. */
export const QUEUE_ADVENTURE_LAB_IMPORT = "adventure-lab-import";
