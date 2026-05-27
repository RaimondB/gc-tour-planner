-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- osm2pgsql flex-output configuration for gc-tour-planner.
--
-- Imports landuse polygons of 10 canonical kinds into the `landuse_polygons`
-- table. The kind classifier is the Lua equivalent of
-- apps/api/src/osm/landuse-classify.ts — keep the two in lockstep. The
-- migration in packages/db/migrations/1779610000000_landuse_polygons.sql
-- pre-creates the table with the matching schema so testcontainers /
-- integration tests have something to seed against; osm2pgsql --create
-- drops and recreates it on first import using THIS definition as the
-- source of truth.
--
-- Reference: https://osm2pgsql.org/doc/manual.html#the-flex-output

local landuse = osm2pgsql.define_table({
    name = 'landuse_polygons',
    -- Auto-emit osm_id (way / relation id) and osm_type ('w' / 'r').
    ids = { type = 'any', id_column = 'osm_id', type_column = 'osm_type' },
    columns = {
        { column = 'kind', type = 'text',         not_null = true },
        -- MultiPolygon in 4326. osm2pgsql normalises closed ways and
        -- multipolygon relations into the same shape; rings get assembled
        -- automatically and inner rings become holes.
        { column = 'geom', type = 'multipolygon', not_null = true, projection = 4326 },
    },
    indexes = {
        { column = 'geom', method = 'gist' },
        { column = 'kind', method = 'btree' },
    },
})

-- Mirror of apps/api/src/osm/landuse-classify.ts. Order matters: more
-- specific tags win over generic ones. Returns nil if the polygon
-- shouldn't be imported.
local function classify(tags)
    local lu = tags.landuse
    if lu == 'forest'      then return 'forest'      end
    if lu == 'park'        then return 'park'        end
    if lu == 'residential' then return 'residential' end
    if lu == 'farmland'    then return 'farmland'    end
    if lu == 'industrial'  then return 'industrial'  end
    if lu == 'meadow'      then return 'meadow'      end
    if lu == 'heath'       then return 'heath'       end
    if lu == 'scrub'       then return 'scrub'       end

    local nat = tags.natural
    if nat == 'wood'    then return 'forest'  end
    if nat == 'water'   then return 'water'   end
    if nat == 'wetland' then return 'wetland' end
    if nat == 'heath'   then return 'heath'   end
    if nat == 'scrub'   then return 'scrub'   end

    local le = tags.leisure
    if le == 'park'           then return 'park' end
    if le == 'nature_reserve' then return 'park' end

    return nil
end

-- A closed way with one of our landuse tags. Emit as MultiPolygon (single
-- ring wrapped) so the schema is uniform with multipolygon relations.
function osm2pgsql.process_way(object)
    if not object.is_closed then return end
    local kind = classify(object.tags)
    if not kind then return end
    landuse:insert({
        kind = kind,
        geom = object:as_multipolygon(),
    })
end

-- Multipolygon relations. type=multipolygon (and rarely type=boundary) holds
-- the rings via member ways with role 'outer' / 'inner'. osm2pgsql handles
-- the geometry assembly; we just decide whether to emit and pick the kind.
function osm2pgsql.process_relation(object)
    local rtype = object.tags.type
    if rtype ~= 'multipolygon' and rtype ~= 'boundary' then return end
    local kind = classify(object.tags)
    if not kind then return end
    landuse:insert({
        kind = kind,
        geom = object:as_multipolygon(),
    })
end
