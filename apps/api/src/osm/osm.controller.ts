// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Landuse } from "@gctp/shared";
import { OsmService } from "./osm.service.js";

@ApiTags("osm")
@Controller("landuse")
export class OsmController {
  constructor(private readonly service: OsmService) {}

  @Get()
  @ApiOperation({
    summary:
      "Return cached OSM landuse polygons in the requested bbox. Triggers a synchronous Overpass refresh on cell miss/stale.",
  })
  @ApiQuery({ name: "minLng", required: true, type: Number })
  @ApiQuery({ name: "minLat", required: true, type: Number })
  @ApiQuery({ name: "maxLng", required: true, type: Number })
  @ApiQuery({ name: "maxLat", required: true, type: Number })
  @ApiQuery({ name: "kinds", required: false, isArray: true, type: String })
  @ApiResponse({
    status: 200,
    description: "GeoJSON FeatureCollection of landuse polygons.",
  })
  async list(
    @Query("minLng") minLng?: string,
    @Query("minLat") minLat?: string,
    @Query("maxLng") maxLng?: string,
    @Query("maxLat") maxLat?: string,
    @Query("kinds") kindsRaw?: string | string[],
  ): Promise<Landuse.LanduseResponse> {
    const kinds =
      kindsRaw === undefined
        ? undefined
        : Array.isArray(kindsRaw)
          ? kindsRaw
          : [kindsRaw];

    const parsed = Landuse.LanduseQuery.safeParse({
      bbox: {
        minLng: Number(minLng),
        minLat: Number(minLat),
        maxLng: Number(maxLng),
        maxLat: Number(maxLat),
      },
      kinds,
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.service.listLanduse(parsed.data);
  }
}
