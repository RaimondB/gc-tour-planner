// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Injectable } from "@nestjs/common";
import argon2 from "argon2";

/**
 * argon2id password hashing (ADR-0021 / NFR-10). Parameters target ~50–100 ms
 * on the deploy hardware: 19 MiB memory cost, 2 iterations, single lane. argon2
 * embeds the parameters + salt in the encoded hash, so `verify` needs no
 * external state and a later parameter bump stays backwards-compatible with
 * already-stored hashes.
 */
@Injectable()
export class PasswordService {
  private readonly options = {
    type: argon2.argon2id,
    memoryCost: 19_456, // KiB ≈ 19 MiB
    timeCost: 2,
    parallelism: 1,
  } as const;

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  /**
   * Verify a candidate against a stored encoded hash. Returns false (never
   * throws) on a malformed hash so a corrupt row reads as "wrong password"
   * rather than a 500 that would leak that the account exists.
   */
  async verify(encodedHash: string, candidate: string): Promise<boolean> {
    try {
      return await argon2.verify(encodedHash, candidate);
    } catch {
      return false;
    }
  }
}
