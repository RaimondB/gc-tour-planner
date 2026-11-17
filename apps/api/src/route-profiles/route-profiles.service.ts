// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { RouteProfiles } from "@gctp/shared";
import { LanduseProfilesRepository } from "../landuse-profiles/landuse-profiles.repository.js";
import { RouteProfilesRepository } from "./route-profiles.repository.js";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * Route profiles (FR-T19, ADR-0039). Owner scoping lives in the repository;
 * this layer turns "not yours / doesn't exist" into 404, a duplicate name into
 * 409, and rejects a landuse profile the caller can't see.
 */
@Injectable()
export class RouteProfilesService {
  constructor(
    private readonly repo: RouteProfilesRepository,
    private readonly landuseProfiles: LanduseProfilesRepository,
  ) {}

  list(ownerId: string): Promise<RouteProfiles.RouteProfile[]> {
    return this.repo.list(ownerId);
  }

  async create(
    ownerId: string,
    input: RouteProfiles.SaveRouteProfileInput,
  ): Promise<RouteProfiles.RouteProfile> {
    await this.assertLanduseProfileVisible(ownerId, input);
    return this.withNameConflict(() => this.repo.create(ownerId, input));
  }

  async update(
    ownerId: string,
    id: string,
    input: RouteProfiles.SaveRouteProfileInput,
  ): Promise<RouteProfiles.RouteProfile> {
    await this.assertLanduseProfileVisible(ownerId, input);
    const updated = await this.withNameConflict(() =>
      this.repo.update(ownerId, id, input),
    );
    if (!updated) throw new NotFoundException("Route profile not found");
    return updated;
  }

  async delete(ownerId: string, id: string): Promise<void> {
    if (!(await this.repo.delete(ownerId, id))) {
      throw new NotFoundException("Route profile not found");
    }
  }

  private async assertLanduseProfileVisible(
    ownerId: string,
    input: RouteProfiles.SaveRouteProfileInput,
  ): Promise<void> {
    const id = input.settings.objective.landuseProfileId;
    if (id && !(await this.landuseProfiles.findById(ownerId, id))) {
      throw new BadRequestException("Unknown landuse profile");
    }
  }

  private async withNameConflict<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          "You already have a profile with this name",
        );
      }
      throw err;
    }
  }
}
