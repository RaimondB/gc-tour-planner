// Copyright (C) 2026 Raimond Brookman and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ParkingFacilities } from "@gctp/shared";
import { OsmService } from "./osm.service.js";

@ApiTags("osm")
@Controller("parking-facilities")
export class ParkingFacilitiesController {
  constructor(private readonly service: OsmService) {}

  @Get()
  @ApiOperation({
    summary:
      "Return OSM amenity=parking features in the requested bbox (ADR-0011). Optional access + fee filters; same server-side LOD as /landuse.",
  })
  @ApiQuery({ name: "minLng", required: true, type: Number })
  @ApiQuery({ name: "minLat", required: true, type: Number })
  @ApiQuery({ name: "maxLng", required: true, type: Number })
  @ApiQuery({ name: "maxLat", required: true, type: Number })
  @ApiQuery({ name: "access", required: false, isArray: true, type: String })
  @ApiQuery({
    name: "fee",
    required: false,
    enum: ParkingFacilities.PARKING_FEE_FILTER as unknown as string[],
  })
  @ApiResponse({
    status: 200,
    description:
      "GeoJSON FeatureCollection of parking facilities. Geometry is Point for OSM nodes, MultiPolygon for ways / relations.",
  })
  async list(
    @Query("minLng") minLng?: string,
    @Query("minLat") minLat?: string,
    @Query("maxLng") maxLng?: string,
    @Query("maxLat") maxLat?: string,
    @Query("access") accessRaw?: string | string[],
    @Query("fee") feeRaw?: string,
  ): Promise<ParkingFacilities.ParkingFacilitiesResponse> {
    const access =
      accessRaw === undefined
        ? undefined
        : Array.isArray(accessRaw)
          ? accessRaw
          : [accessRaw];

    const parsed = ParkingFacilities.ParkingFacilitiesQuery.safeParse({
      bbox: {
        minLng: Number(minLng),
        minLat: Number(minLat),
        maxLng: Number(maxLng),
        maxLat: Number(maxLat),
      },
      access,
      fee: feeRaw,
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.service.listParkingFacilities(parsed.data);
  }
}
