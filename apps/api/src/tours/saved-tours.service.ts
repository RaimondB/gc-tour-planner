// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { Injectable, NotFoundException } from "@nestjs/common";
import { Geo, Tours } from "@gctp/shared";
import { CachesRepository } from "../caches/caches.repository.js";
import {
  type SaveTourRow,
  SavedToursRepository,
  type TourDetailRow,
  type TourSummaryRow,
} from "./saved-tours.repository.js";

/**
 * Save / list / open / rename / delete persisted tours (M6-γ, FR-P1/FR-P2).
 *
 * The typed columns are derived here from the client's PlanResult — never
 * trusted from a separate wire field — and the public cache snapshot is baked
 * at save time from the owner's own caches, so the saved `plan` is wholly
 * server-vouched. Cross-tenant reads surface as 404 (FR-P2.2).
 */
@Injectable()
export class SavedToursService {
  constructor(
    private readonly repo: SavedToursRepository,
    private readonly caches: CachesRepository,
  ) {}

  async save(
    ownerId: string,
    input: Tours.SaveTourInput,
  ): Promise<Tours.SavedTourDetail> {
    const fields = await this.derivePersistFields(ownerId, input);
    const row = await this.repo.save({ ownerId, ...fields });
    return this.toDetail(row);
  }

  /**
   * Overwrite an existing tour in place with a re-planned / edited route
   * (FR-P2.4). Re-derives the snapshot + typed columns exactly like {@link save}
   * (the route is wholly server-vouched); the repo preserves `created_at`, the
   * share slug, and the stored preview. 404 cross-tenant.
   */
  async update(
    ownerId: string,
    id: string,
    input: Tours.UpdateTourInput,
  ): Promise<Tours.SavedTourDetail> {
    const fields = await this.derivePersistFields(ownerId, input);
    const row = await this.repo.update(ownerId, id, fields);
    if (!row) throw new NotFoundException("Tour not found");
    return this.toDetail(row);
  }

  /**
   * Derive the persisted columns from the client's PlanResult: bake a
   * point-in-time cache snapshot from the owner's own caches (so the saved tour
   * and the public shared view render without re-reading owner-scoped tables
   * later — ADR-0022; ids that no longer resolve are simply absent, FR-P1.3),
   * and compute the typed columns server-side. Shared by save + update so the
   * two never drift.
   */
  private async derivePersistFields(
    ownerId: string,
    input: Tours.SaveTourInput,
  ): Promise<Omit<SaveTourRow, "ownerId">> {
    const { plan } = input;
    const dtos = await this.caches.findByIds(ownerId, plan.orderedCacheIds);
    const caches: Tours.StoredPlan["caches"] = dtos.map((c) => ({
      id: c.id,
      code: c.code,
      type: c.type,
      name: c.name,
      location: c.location,
    }));
    const storedPlan: Tours.StoredPlan = { ...plan, caches };

    // start_point is the loop anchor (parking.point is always present, even on
    // a centroid fallback); parking_point is the *chosen* parking, NULL when
    // the planner fell back to the centroid.
    const [startLng, startLat] = plan.parking.point.coordinates;
    return {
      name: input.name,
      startPoint: { lng: startLng, lat: startLat },
      parkingPoint: plan.parking.fallback
        ? null
        : { lng: startLng, lat: startLat },
      cacheIds: plan.orderedCacheIds,
      totalMeters: plan.totals.meters,
      totalSeconds: plan.totals.seconds,
      geom: plan.polyline,
      scoreBreakdown: plan.scoreBreakdown,
      plan: storedPlan,
    };
  }

  /**
   * Mint (idempotent) a public share link for a tour (FR-P3.1). Returns the
   * opaque slug + the client-relative path. 404 cross-tenant.
   */
  async share(ownerId: string, id: string): Promise<Tours.ShareResponse> {
    const slug = await this.repo.share(ownerId, id);
    if (!slug) throw new NotFoundException("Tour not found");
    return { slug, path: `/shared/${slug}` };
  }

  /** Revoke a tour's share (FR-P3.4). 404 cross-tenant. */
  async unshare(ownerId: string, id: string): Promise<void> {
    const ok = await this.repo.unshare(ownerId, id);
    if (!ok) throw new NotFoundException("Tour not found");
  }

  /**
   * Public read of a shared tour by slug (FR-P3.2, ADR-0022). Assembles the
   * safe public subset from the stored snapshot only — name, totals, geometry,
   * parking point, cache list — and drops everything else (score breakdown,
   * owner identity, dropped caches, per-leg detail). 404 when the slug is
   * unknown or has been revoked.
   */
  async getSharedBySlug(slug: string): Promise<Tours.SharedTour> {
    const row = await this.repo.findBySlug(slug);
    if (!row) throw new NotFoundException("Shared tour not found");
    const plan = Tours.StoredPlan.parse(row.plan);
    return {
      name: row.name,
      totals: plan.totals,
      polyline: plan.polyline,
      parking: plan.parking.fallback ? null : plan.parking.point,
      caches: plan.caches,
    };
  }

  async list(ownerId: string): Promise<Tours.SavedTourSummary[]> {
    const rows = await this.repo.list(ownerId);
    return rows.map((r) => this.toSummary(r));
  }

  /**
   * Lean footprints for the planner-map background layer (Feature 1). Parses the
   * simplified GeoJSON LineString of each saved tour's loop. Owner-scoped.
   */
  async footprints(ownerId: string): Promise<Tours.SavedTourFootprint[]> {
    const rows = await this.repo.footprints(ownerId);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      geometry: Geo.GeoJsonLineString.parse(JSON.parse(r.geom_geojson)),
    }));
  }

  async getById(ownerId: string, id: string): Promise<Tours.SavedTourDetail> {
    const row = await this.repo.findById(ownerId, id);
    if (!row) throw new NotFoundException("Tour not found");
    return this.toDetail(row);
  }

  async rename(
    ownerId: string,
    id: string,
    name: string,
  ): Promise<Tours.SavedTourDetail> {
    const row = await this.repo.rename(ownerId, id, name);
    if (!row) throw new NotFoundException("Tour not found");
    return this.toDetail(row);
  }

  async delete(ownerId: string, id: string): Promise<void> {
    const ok = await this.repo.delete(ownerId, id);
    if (!ok) throw new NotFoundException("Tour not found");
  }

  /**
   * Store the client-captured map snapshot (FR-W4). Owner-scoped; a cross-tenant
   * id surfaces as 404 like every other route here.
   */
  async savePreview(
    ownerId: string,
    id: string,
    image: Buffer,
    mime: string,
  ): Promise<void> {
    const ok = await this.repo.savePreview(ownerId, id, image, mime);
    if (!ok) throw new NotFoundException("Tour not found");
  }

  /** Read a tour's stored snapshot; 404 when missing or not the caller's. */
  async getPreview(
    ownerId: string,
    id: string,
  ): Promise<{ image: Buffer; mime: string }> {
    const preview = await this.repo.getPreview(ownerId, id);
    if (!preview) throw new NotFoundException("Tour preview not found");
    return preview;
  }

  private toSummary(r: TourSummaryRow): Tours.SavedTourSummary {
    return {
      id: r.id,
      name: r.name,
      totalMeters: Number(r.total_meters),
      totalSeconds: Number(r.total_seconds),
      cacheCount: r.cache_count,
      isShared: r.is_shared,
      hasPreview: r.has_preview,
      startPoint: JSON.parse(
        r.start_geojson,
      ) as Tours.SavedTourSummary["startPoint"],
      createdAt: r.created_at.toISOString(),
    };
  }

  private toDetail(r: TourDetailRow): Tours.SavedTourDetail {
    return {
      ...this.toSummary(r),
      parkingPoint: r.parking_geojson
        ? (JSON.parse(
            r.parking_geojson,
          ) as Tours.SavedTourDetail["parkingPoint"])
        : null,
      // Re-validate the stored JSONB on read — the column is untyped at the DB
      // layer, and this guards against a schema drift surfacing bad data.
      plan: Tours.StoredPlan.parse(r.plan),
    };
  }
}
