// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * DI token for the shared ioredis client connected to Valkey. Used by the
 * session store, the per-email login limiter, and the throttler storage. This
 * is a separate connection from the BullMQ one (which BullMQ manages itself);
 * keeping them apart avoids command pipelining contention on the queue
 * connection's hot path.
 */
export const VALKEY = Symbol.for("@gctp/api/auth/VALKEY");
