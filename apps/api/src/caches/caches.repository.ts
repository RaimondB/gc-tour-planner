// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Inject, Injectable } from "@nestjs/common";
import { Caches } from "@gctp/shared";
import type { Database } from "@gctp/db";
import { type Kysely, sql } from "kysely";
import { KYSELY } from "../database/database.tokens.js";

export interface FindCachesParams {
  ownerId: string;
  center: [number, number];
  radiusM: number;
  types?: readonly Caches.CacheType[];
  /** AND-of-OR groups; an empty outer array means "no attribute filter". */
  attributeGroups?: readonly (readonly Caches.AttributeFilter[])[];
}

interface CacheRow {
  id: string;
  source: string;
  source_id: string;
  code: string;
  type: string;
  name: string;
  lng: number;
  lat: number;
  difficulty: string | null;
  terrain: string | null;
  size: string | null;
  archived: boolean;
  attribute_ids: number[];
  parking_lngs: number[];
  parking_lats: number[];
}

@Injectable()
export class CachesRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async find(p: FindCachesParams): Promise<Caches.CacheDTO[]> {
    const [lng, lat] = p.center;

    let q = this.db
      .selectFrom("caches as c")
      .select((eb) => [
        "c.id",
        "c.source",
        "c.source_id",
        "c.code",
        "c.type",
        "c.name",
        sql<number>`ST_X(c.location::geometry)`.as("lng"),
        sql<number>`ST_Y(c.location::geometry)`.as("lat"),
        "c.difficulty",
        "c.terrain",
        "c.size",
        "c.archived",
        eb
          .selectFrom("cache_attributes as a")
          .whereRef("a.cache_id", "=", "c.id")
          .where("a.positive", "=", true)
          .select(
            sql<
              number[]
            >`COALESCE(array_agg(a.attr_id ORDER BY a.attr_id), ARRAY[]::int[])`.as(
              "attribute_ids",
            ),
          )
          .as("attribute_ids"),
        eb
          .selectFrom("additional_waypoints as w")
          .whereRef("w.cache_id", "=", "c.id")
          .where("w.type", "=", "parking")
          .select(
            sql<
              number[]
            >`COALESCE(array_agg(ST_X(w.location::geometry)), ARRAY[]::float8[])`.as(
              "parking_lngs",
            ),
          )
          .as("parking_lngs"),
        eb
          .selectFrom("additional_waypoints as w")
          .whereRef("w.cache_id", "=", "c.id")
          .where("w.type", "=", "parking")
          .select(
            sql<
              number[]
            >`COALESCE(array_agg(ST_Y(w.location::geometry)), ARRAY[]::float8[])`.as(
              "parking_lats",
            ),
          )
          .as("parking_lats"),
      ])
      .where("c.owner_id", "=", p.ownerId)
      .where(
        sql<boolean>`ST_DWithin(c.location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${p.radiusM})`,
      );

    if (p.types && p.types.length > 0) {
      q = q.where("c.type", "in", p.types as unknown as string[]);
    }

    if (p.attributeGroups && p.attributeGroups.length > 0) {
      for (const group of p.attributeGroups) {
        if (group.length === 0) continue;
        q = q.where((eb) =>
          eb.exists(
            eb
              .selectFrom("cache_attributes as ca")
              .select(sql<number>`1`.as("one"))
              .whereRef("ca.cache_id", "=", "c.id")
              .where((eb2) =>
                eb2.or(
                  group.map((f) =>
                    eb2.and([
                      eb2("ca.attr_id", "=", f.id),
                      eb2("ca.positive", "=", f.positive),
                    ]),
                  ),
                ),
              ),
          ),
        );
      }
    }

    const rows = (await q.execute()) as unknown as CacheRow[];

    return rows.map<Caches.CacheDTO>((r) => {
      const parking: Caches.CacheDTO["parkingPoints"] = [];
      const lngs = r.parking_lngs ?? [];
      const lats = r.parking_lats ?? [];
      for (let i = 0; i < lngs.length && i < lats.length; i += 1) {
        const plng = lngs[i];
        const plat = lats[i];
        if (typeof plng === "number" && typeof plat === "number")
          parking.push([plng, plat]);
      }

      return {
        id: Number(r.id),
        source: r.source,
        sourceId: r.source_id,
        code: r.code,
        type: r.type as Caches.CacheType,
        name: r.name,
        location: { type: "Point", coordinates: [r.lng, r.lat] },
        difficulty: r.difficulty === null ? null : Number(r.difficulty),
        terrain: r.terrain === null ? null : Number(r.terrain),
        size: r.size,
        archived: r.archived,
        attributeIds: r.attribute_ids ?? [],
        parkingPoints: parking,
      };
    });
  }
}
