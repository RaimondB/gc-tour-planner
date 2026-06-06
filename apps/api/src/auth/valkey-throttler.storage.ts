// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { Redis } from "ioredis";
import { VALKEY } from "./valkey.tokens.js";

/**
 * Structural copy of `@nestjs/throttler`'s `ThrottlerStorageRecord` — the
 * package re-exports the storage interface but not the record interface, so we
 * restate it here (the storage's `increment` resolves to this shape).
 */
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Valkey-backed `@nestjs/throttler` storage so per-IP rate limits hold across
 * API replicas (FR-P9) instead of living in a single process's memory. The
 * fixed-window increment + block check runs in one atomic Lua call so
 * concurrent requests can't race past the limit.
 *
 * Unit contract (matches the in-memory default): `ttl`/`blockDuration` arrive in
 * **milliseconds**; `timeToExpire`/`timeToBlockExpire` are returned in
 * **seconds**.
 */
@Injectable()
export class ValkeyThrottlerStorage implements ThrottlerStorage {
  // KEYS: [hitKey, blockKey]; ARGV: [ttlMs, limit, blockDurationMs]
  // Returns: [totalHits, hitPttlMs, isBlocked(0|1), blockPttlMs]
  private readonly script = `
    local hitKey = KEYS[1]
    local blockKey = KEYS[2]
    local ttl = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local blockDuration = tonumber(ARGV[3])

    local blockPttl = redis.call('PTTL', blockKey)
    if blockPttl > 0 then
      local hp = redis.call('PTTL', hitKey)
      if hp < 0 then hp = 0 end
      return {limit + 1, hp, 1, blockPttl}
    end

    local totalHits = redis.call('INCR', hitKey)
    local hitPttl = redis.call('PTTL', hitKey)
    if hitPttl < 0 then
      redis.call('PEXPIRE', hitKey, ttl)
      hitPttl = ttl
    end

    local isBlocked = 0
    local blockOut = 0
    if totalHits > limit then
      redis.call('SET', blockKey, '1', 'PX', blockDuration)
      isBlocked = 1
      blockOut = blockDuration
    end
    return {totalHits, hitPttl, isBlocked, blockOut}
  `;

  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:block`;
    // A 0 blockDuration would make `PX 0` invalid; fall back to the window ttl.
    const blockMs = blockDuration > 0 ? blockDuration : ttl;

    const res = (await this.valkey.eval(
      this.script,
      2,
      hitKey,
      blockKey,
      String(ttl),
      String(limit),
      String(blockMs),
    )) as [number, number, number, number];

    const [totalHits, hitPttlMs, isBlocked, blockPttlMs] = res;
    return {
      totalHits,
      timeToExpire: Math.ceil(hitPttlMs / 1000),
      isBlocked: isBlocked === 1,
      timeToBlockExpire: Math.ceil(blockPttlMs / 1000),
    };
  }
}
