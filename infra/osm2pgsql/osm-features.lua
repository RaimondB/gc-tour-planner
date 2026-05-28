-- Copyright (C) 2026 Raimond Brookman and contributors
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- osm2pgsql flex-output configuration for gc-tour-planner.
--
-- Single Lua script, two output tables, single PBF pass:
--   * landuse_polygons    — landuse / natural / leisure polygons used for
--                           cluster scoring (ADR-0009).
--   * parking_facilities  — amenity=parking nodes/ways/relations used for
--                           tour-start picking + map overlay (ADR-0011).
--
-- Schema must stay in lockstep with the matching migrations:
--   * packages/db/migrations/1779610000000_landuse_polygons.sql
--   * packages/db/migrations/1779620000000_parking_facilities.sql
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

-- ─── Callbacks ─────────────────────────────────────────────────────────────

-- Nodes: only parking nodes are emitted. Landuse never comes from nodes.
function osm2pgsql.process_node(object)
    if object.tags.amenity ~= 'parking' then return end
    local row = parking_attrs(object.tags)
    row.geom = object:as_point()
    parking:insert(row)
end

-- Closed ways. May emit to landuse, parking, or both (a closed way can
-- have both landuse + amenity tags in principle; in practice it's one or
-- the other).
function osm2pgsql.process_way(object)
    if not object.is_closed then return end

    local kind = classify_landuse(object.tags)
    if kind then
        landuse:insert({
            kind = kind,
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
            geom = object:as_multipolygon(),
        })
    end

    if object.tags.amenity == 'parking' then
        local row = parking_attrs(object.tags)
        row.geom = object:as_multipolygon()
        parking:insert(row)
    end
end
