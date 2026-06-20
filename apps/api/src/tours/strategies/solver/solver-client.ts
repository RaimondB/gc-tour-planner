// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** Request body posted to the Timefold sidecar's POST /plan. */
export interface SolverPlanRequest {
  caches: ReadonlyArray<{
    id: number;
    lng: number;
    lat: number;
    /** Adventure this node belongs to (null for a plain cache); groups the
     *  atomicity + contiguity constraints. */
    adventureId: string | null;
    /** Within-adventure stage order (null for a plain cache). */
    stageSequence: number | null;
    /** True when this node belongs to a *linear* adventure — its stages must be
     *  visited in `stageSequence` order (other caches may still interleave). */
    adventureSequential: boolean;
  }>;
  /** N×N. `null` cells mark unreachable pairs. */
  matrixMeters: (number | null)[][];
  matrixSeconds: (number | null)[][];
  parkingToCacheMeters: number[];
  parkingToCacheSeconds: number[];
  cacheToParkingMeters: number[];
  cacheToParkingSeconds: number[];
  distanceBudgetMeters: number;
  /** Omit (or null) to skip the time-budget hard constraint. */
  timeBudgetSeconds: number | null;
  visitSecondsPerCache: number;
  /** Adventure Lab atomicity — include an adventure whole or not at all. */
  completeAdventuresOnly: boolean;
  /** When false, an adventure's stages must be one contiguous block. */
  adventureInterleave: boolean;
  /** `visitedCount` = MEDIUM reward (count dominates); `loopLength` = SOFT
   *  penalty per metre (compacts the loop among equal-count solutions). */
  weights: { visitedCount: number; loopLength: number };
}

export interface SolverPlanResponse {
  orderedCacheIds: number[];
  totalMeters: number;
  totalSeconds: number;
  visitedCount: number;
}

export interface SolverClient {
  plan(req: SolverPlanRequest): Promise<SolverPlanResponse>;
  health(): Promise<boolean>;
}

export const SOLVER_CLIENT = Symbol.for("@gctp/api/tours/SOLVER_CLIENT");

const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 2_000;

/**
 * Thin HTTP client for the Timefold sidecar. Owns three concerns and nothing
 * else:
 *
 *  1. Build the URL from `SOLVER_URL` (compose default: http://solver:8080).
 *  2. Enforce a wall-clock timeout on `/plan` via AbortController.
 *  3. Surface upstream failures as `ServiceUnavailableException` so the API
 *     returns 503 — never silently fall back to greedy (ADR-0005 §Fallback).
 */
@Injectable()
export class HttpSolverClient implements SolverClient {
  private readonly logger = new Logger(HttpSolverClient.name);
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.base = (
      config.get<string>("SOLVER_URL") ?? "http://solver:8080"
    ).replace(/\/+$/, "");
    const env = config.get<string>("SOLVER_TIMEOUT_MS");
    this.timeoutMs = env ? Number.parseInt(env, 10) : DEFAULT_TIMEOUT_MS;
  }

  async plan(req: SolverPlanRequest): Promise<SolverPlanResponse> {
    const url = `${this.base}/plan`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new ServiceUnavailableException(
          `Solver /plan ${res.status}: ${body.slice(0, 200)}`,
        );
      }
      return (await res.json()) as SolverPlanResponse;
    } catch (err) {
      // Re-throw our own 503s untouched; wrap network / abort errors.
      if (err instanceof ServiceUnavailableException) throw err;
      const detail =
        (err as { cause?: Error })?.cause?.message ?? (err as Error).message;
      throw new ServiceUnavailableException(
        `Solver at ${this.base} unreachable: ${detail}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<boolean> {
    const url = `${this.base}/actuator/health`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return false;
      const json = (await res.json()) as { status?: string };
      return json.status === "UP";
    } catch (err) {
      this.logger.debug(`health check failed: ${(err as Error).message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
