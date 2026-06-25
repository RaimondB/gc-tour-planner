-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- osm2pgsql flex-output configuration for gc-tour-planner.
--
-- Single Lua script, four output tables, single PBF pass:
--   * landuse_polygons    — landuse / natural / leisure polygons used for
--                           cluster scoring (ADR-0009); `name` anchors a tour's
--                           "place" when it sits in a named park/forest (ADR-0036).
--   * parking_facilities  — amenity=parking nodes/ways/relations used for
--                           tour-start picking + map overlay (ADR-0011).
--   * car_roads           — quiet, car-accessible road ways used to snap
--                           "nearest road" tour-start parking (ADR-0012).
--   * place_points        — named settlement nodes (place=city/town/village/
--                           hamlet/suburb) used to name a tour by its town (ADR-0036).
--
-- Schema must stay in lockstep with the matching migrations:
--   * packages/db/migrations/1779610000000_landuse_polygons.sql
--     + 1786000000000_landuse_polygons_name.sql
--   * packages/db/migrations/1779620000000_parking_facilities.sql
--   * packages/db/migrations/1779680000000_car_roads.sql
--   * packages/db/migrations/1786000000001_place_points.sql
--
-- The kind classifier for landuse is the Lua equivalent of
-- apps/api/src/osm/landuse-classify.ts — keep the two in lockstep.
--
-- Reference: https://osm2pgsql.org/doc/manual.html#the-flex-output

-- ─── Landuse ───────────────────────────────────────────────────────────────

local landuse = osm2pgsql.define_table({
    name = 'landuse_polygons',
    -- Auto-emit osm_id (way / relation id) and osm_type ('w' / 'r').
    ids = { type = 'any', id_column = 'osm_id', type_column = 'osm_type' },
    columns = {
        { column = 'kind', type = 'text',         not_null = true },
        -- OSM name of the feature, when tagged — surfaces a named park / forest /
        -- nature reserve ("Bospark", "de Veluwe") as a tour's "place" anchor for
        -- naming (FR-P1.x). NULL for the many unnamed landuse polygons.
        { column = 'name', type = 'text' },
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
local function classify_landuse(tags)
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

-- ─── Place points (settlements) ─────────────────────────────────────────────
--
-- Named settlement nodes (place=city/town/village/hamlet/suburb) — the source
-- of a tour's human "place" label ("Wageningen"). Points only (OSM maps
-- settlements as a node at the centre); the nearest one to a tour's start
-- anchors its name. Deliberately excludes finer place kinds (neighbourhood /
-- locality / isolated_dwelling) to keep the table small and the labels
-- recognisable. See ADR-0036.

local PLACE_KINDS = {
    city    = true,
    town    = true,
    village = true,
    hamlet  = true,
    suburb  = true,
}

local place_points = osm2pgsql.define_table({
    name = 'place_points',
    ids = { type = 'node', id_column = 'osm_id' },
    columns = {
        { column = 'place',      type = 'text',  not_null = true },
        { column = 'name',       type = 'text',  not_null = true },
        -- Population (when tagged) breaks ties toward the bigger settlement.
        { column = 'population', type = 'int' },
        { column = 'geom',       type = 'point', not_null = true, projection = 4326 },
    },
    indexes = {
        { column = 'geom',  method = 'gist' },
        { column = 'place', method = 'btree' },
    },
})

local function parse_population(s)
    if not s then return nil end
    local m = string.match(s, '(%d+)')
    return m and tonumber(m) or nil
end

-- ─── Parking facilities ────────────────────────────────────────────────────

local parking = osm2pgsql.define_table({
    name = 'parking_facilities',
    -- type='any' lets osm2pgsql emit rows from node/way/relation handlers
    -- into the same table; the type column captures which it came from.
    ids = { type = 'any', id_column = 'osm_id', type_column = 'osm_type' },
    columns = {
        -- Untyped geometry — nodes yield Point, ways/relations yield
        -- (Multi)Polygon. The schema in the migration is GEOMETRY (not a
        -- typed subtype) so both fit without casts at insert time.
        { column = 'geom',          type = 'geometry', not_null = true, projection = 4326 },
        { column = 'access',        type = 'text' },
        { column = 'fee',           type = 'text' },
        { column = 'parking_type',  type = 'text' },
        { column = 'capacity',      type = 'int' },
        { column = 'maxstay',       type = 'text' },
        { column = 'supervised',    type = 'text' },
        { column = 'opening_hours', type = 'text' },
        { column = 'surface',       type = 'text' },
        { column = 'name',          type = 'text' },
    },
    indexes = {
        { column = 'geom',   method = 'gist' },
        { column = 'access', method = 'btree' },
        { column = 'fee',    method = 'btree' },
    },
})

-- Capacity tags are usually a plain integer but sometimes carry a unit
-- ("30 cars") or a range ("20-30"). Parse defensively; nil on anything we
-- can't reduce to an integer.
local function parse_capacity(s)
    if not s then return nil end
    local n = tonumber(s)
    if n then return math.floor(n) end
    local m = string.match(s, '(%d+)')
    if m then return tonumber(m) end
    return nil
end

-- Normalise the `parking:condition` family into the same domain as `fee`
-- (OSM convention: disc-zone parking is free). Returns the effective fee
-- value to store, falling back to the raw `fee` tag.
local function effective_fee(tags)
    local cond = tags['parking:condition']
    if cond == 'disc' or cond == 'free' then return 'no' end
    if cond == 'ticket' or cond == 'fee' then return 'yes' end
    return tags.fee
end

-- Build the row payload from a tag table. Returned table excludes geom —
-- callers add geom + insert depending on object kind.
local function parking_attrs(tags)
    return {
        access        = tags.access,
        fee           = effective_fee(tags),
        parking_type  = tags.parking,
        capacity      = parse_capacity(tags.capacity),
        maxstay       = tags.maxstay,
        supervised    = tags.supervised,
        opening_hours = tags.opening_hours,
        surface       = tags.surface,
        name          = tags.name,
    }
end

-- ─── Car-accessible roads (ADR-0012) ────────────────────────────────────────

local car_roads = osm2pgsql.define_table({
    name = 'car_roads',
    -- Roads are ways. Relations (route=*) carry no own geometry we want.
    ids = { type = 'way', id_column = 'osm_id' },
    columns = {
        -- LineString in 4326. Roads are open ways (roundabouts/cul-de-sacs
        -- are closed but as_linestring still produces a valid line).
        { column = 'geom',          type = 'linestring', not_null = true, projection = 4326 },
        { column = 'highway',       type = 'text', not_null = true },
        { column = 'access',        type = 'text' },
        { column = 'motor_vehicle', type = 'text' },
        -- Pre-parsed km/h so the fine filter is a plain integer comparison.
        { column = 'maxspeed_kmh',  type = 'int' },
        { column = 'service',       type = 'text' },
        { column = 'name',          type = 'text' },
    },
    indexes = {
        { column = 'geom',    method = 'gist' },
        { column = 'highway', method = 'btree' },
    },
})

-- Coarse class filter: only quiet roads you can realistically pull over on
-- and get out of the car. Fast/through roads (motorway/trunk/primary/
-- secondary + links) and foot/cycle ways are intentionally excluded here so
-- the table stays small. The *fine* filter (access / motor_vehicle /
-- maxspeed / service=driveway) runs at query time in car-roads.repository.ts
-- so it can be retuned without a re-import — see ADR-0012. Returns the
-- highway value to store, or nil to skip the way.
local CAR_ROAD_CLASSES = {
    residential   = true,
    living_street = true,
    unclassified  = true,
    service       = true,
    tertiary      = true,
}
local function classify_car_road(tags)
    local hw = tags.highway
    if hw and CAR_ROAD_CLASSES[hw] then return hw end
    return nil
end

-- Best-effort maxspeed → integer km/h. Handles plain numbers, "30 mph", and
-- the NL implicit-speed zone tags. nil when absent/unparseable; the query
-- treats nil as "unknown, keep" since the class filter already drops the
-- genuinely fast roads.
local function parse_maxspeed_kmh(tags)
    local ms = tags.maxspeed
    if not ms then return nil end
    if ms == 'none'        then return 999 end
    if ms == 'walk'        then return 5   end
    if ms == 'NL:urban'    then return 50  end
    if ms == 'NL:rural'    then return 80  end
    if ms == 'NL:motorway' then return 100 end
    if ms == 'NL:zone30'   then return 30  end
    local n = string.match(ms, '(%d+)')
    if not n then return nil end
    n = tonumber(n)
    if string.match(ms, 'mph') then return math.floor(n * 1.609) end
    return n
end

local function car_road_attrs(tags, hw)
    return {
        highway       = hw,
        access        = tags.access,
        motor_vehicle = tags.motor_vehicle,
        maxspeed_kmh  = parse_maxspeed_kmh(tags),
        service       = tags.service,
        name          = tags.name,
    }
end

-- ─── Callbacks ─────────────────────────────────────────────────────────────

-- Nodes: parking nodes + named settlement place nodes. Landuse never comes
-- from nodes.
function osm2pgsql.process_node(object)
    local tags = object.tags

    if tags.amenity == 'parking' then
        local row = parking_attrs(tags)
        row.geom = object:as_point()
        parking:insert(row)
    end

    if tags.place and PLACE_KINDS[tags.place] and tags.name then
        place_points:insert({
            place      = tags.place,
            name       = tags.name,
            population = parse_population(tags.population),
            geom       = object:as_point(),
        })
    end
end

-- Closed ways. May emit to landuse, parking, or both (a closed way can
-- have both landuse + amenity tags in principle; in practice it's one or
-- the other).
function osm2pgsql.process_way(object)
    -- Roads first — they are (mostly) open ways, so this must run before the
    -- closed-way guard below. classify_car_road keeps only quiet car classes.
    local hw = classify_car_road(object.tags)
    if hw then
        local row = car_road_attrs(object.tags, hw)
        row.geom = object:as_linestring()
        car_roads:insert(row)
    end

    if not object.is_closed then return end

    local kind = classify_landuse(object.tags)
    if kind then
        landuse:insert({
            kind = kind,
            name = object.tags.name,
            geom = object:as_multipolygon(),
        })
    end

    if object.tags.amenity == 'parking' then
        local row = parking_attrs(object.tags)
        row.geom = object:as_multipolygon()
        parking:insert(row)
    end
end

-- Multipolygon relations. type=multipolygon (and rarely type=boundary)
-- holds the rings via member ways with role 'outer' / 'inner'. osm2pgsql
-- handles the geometry assembly; we just decide whether to emit.
function osm2pgsql.process_relation(object)
    local rtype = object.tags.type
    if rtype ~= 'multipolygon' and rtype ~= 'boundary' then return end

    local kind = classify_landuse(object.tags)
    if kind then
        landuse:insert({
            kind = kind,
            name = object.tags.name,
            geom = object:as_multipolygon(),
        })
    end

    if object.tags.amenity == 'parking' then
        local row = parking_attrs(object.tags)
        row.geom = object:as_multipolygon()
        parking:insert(row)
    end
end
